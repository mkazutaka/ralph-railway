---
status: draft
reviewer:
---

# パターンの挿入

## ストーリー

ユーザが、パターンショーケース（do / if / switch / fork / loop / try-catch / retry / set 等）から1つを選び、編集中のワークフローへ挿入する。挿入後の YAML は構文・スキーマ的に有効でなければならない。

## 型定義

```
data WorkflowId = string
data PatternId = string                       // do, if, switch, fork, loop, try, retry, set
data YamlSource = string

data InsertedPattern =
    WorkflowId: WorkflowId
    PatternId: PatternId
    UpdatedYaml: YamlSource

data InsertPatternError =
    | WorkflowNotFound
    | UnknownPattern                          // パターンIDに対応するテンプレートが存在しない
    | UnsupportedPattern                      // ランタイム未対応のためショーケース上は表示するが挿入不可
    | InvalidBaseYaml of reason: string       // 既存 YAML が壊れていて挿入位置を特定できない
    | IdConflict                              // 生成 ID が既存タスク ID と衝突を解決できない

// dependencies
func readWorkflowFile: WorkflowId -> YamlSource OR NotFound
func loadPatternTemplate: PatternId -> PatternTemplate OR UnknownPattern OR UnsupportedPattern
func parseWorkflowYaml: YamlSource -> WorkflowDocument OR ParseError
func mergePatternIntoDocument: WorkflowDocument AND PatternTemplate -> WorkflowDocument OR IdConflict
func serializeYaml: WorkflowDocument -> YamlSource
func writeWorkflowFile: WorkflowId AND YamlSource -> SavedWorkflow
```

## ワークフロー

```
workflow "Insert Pattern" =
  input: WorkflowId AND PatternId
  output:
    PatternInserted
    OR WorkflowNotFound
    OR UnknownPattern
    OR UnsupportedPattern
    OR InvalidBaseYaml
    OR IdConflict
  dependencies: readWorkflowFile, loadPatternTemplate, parseWorkflowYaml, mergePatternIntoDocument, serializeYaml, writeWorkflowFile

  // step 1
  do LoadBaseWorkflow
  If not found then:
    return WorkflowNotFound
    stop

  // step 2
  do LoadPattern
  If unknown then:
    return UnknownPattern
    stop
  If unsupported then:
    return UnsupportedPattern
    stop

  // step 3
  do ParseBase
  If parse error then:
    return InvalidBaseYaml
    stop

  // step 4
  do MergePattern
  If id conflict then:
    return IdConflict
    stop

  // step 5
  do PersistMergedYaml
  return PatternInserted

substep "LoadBaseWorkflow" =
    input: WorkflowId
    output: YamlSource
        OR WorkflowNotFound
    dependencies: readWorkflowFile

    readWorkflowFile(WorkflowId)
    If not found then:
        return WorkflowNotFound
    return YamlSource

substep "LoadPattern" =
    input: PatternId
    output: PatternTemplate
        OR UnknownPattern
        OR UnsupportedPattern
    dependencies: loadPatternTemplate

    loadPatternTemplate(PatternId)
    If not registered then:
        return UnknownPattern
    If runtime does not support then:
        return UnsupportedPattern
    return PatternTemplate

substep "ParseBase" =
    input: YamlSource
    output: WorkflowDocument
        OR InvalidBaseYaml
    dependencies: parseWorkflowYaml

    parseWorkflowYaml(YamlSource)
    If parse error then:
        return InvalidBaseYaml(reason: parse message)
    return WorkflowDocument

substep "MergePattern" =
    input: WorkflowDocument AND PatternTemplate
    output: WorkflowDocument
        OR IdConflict
    dependencies: mergePatternIntoDocument

    mergePatternIntoDocument(WorkflowDocument, PatternTemplate)
    If unable to allocate unique IDs then:
        return IdConflict
    return WorkflowDocument

substep "PersistMergedYaml" =
    input: WorkflowId AND WorkflowDocument
    output: InsertedPattern
    dependencies: serializeYaml, writeWorkflowFile

    serializeYaml(WorkflowDocument)
    writeWorkflowFile(WorkflowId, YamlSource)
    return InsertedPattern
```

## 不変条件

1. 挿入後の YAML はパース可能でスキーマ準拠
2. 挿入により既存タスクの ID が変更されない（追加されたタスクのみ新規 ID を持つ）
3. ランタイム未対応パターンはショーケースに表示しても挿入は拒否する
4. 構文エラーのある既存 YAML には挿入しない（先に修正させる）

## 設計メモ

- **挿入位置**: 現状の `MergePattern` は `do` 配列の末尾にパターンを追記する。これは
  不変条件2（既存 ID 不変）を最小コストで満たすための設計判断であり、シナリオが
  挿入位置を規定していないことに依拠している。将来 UI から挿入位置を指定可能に
  する場合、本シナリオに `InsertionPoint` を加えてから merge ロジックを変更する
  こと（暗黙の挙動変化を防ぐため）。
- **`IdConflict` と `TemplateMalformed` の分離**: シナリオ上の `IdConflict` は
  「生成 ID が既存タスク ID と衝突を解決できない」事象に限定する。テンプレート
  レジストリ自体が壊れている（エントリの key 数が 1 でない等）場合は内部エラー
  として `TemplateMalformed` を別途返却し、HTTP は 500 にマップする。
- **空の `do`**: `do` キーが欠落している、または `do: null` で値が無い場合は空の
  タスクリスト `[]` として扱う。これは新規作成された YAML への最初のパターン
  挿入を許可するための仕様であり、不変条件4（構文エラーのある YAML には挿入
  しない）と矛盾しない（ここで言う「構文エラー」は YAML として壊れているもの
  に限る）。値がスカラーやマッピング等で `do` の型が一致しない場合は引き続き
  `InvalidBaseYaml` として拒否する。
