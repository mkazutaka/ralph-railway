---
status: draft
reviewer:
---

# ワークフロー実行開始

## ストーリー

ユーザが、編集中のワークフローを Run ボタンから実行開始する。実行はランタイムへ非同期で投入され、Run 識別子が返される。実行進捗・完了は別ワークフロー（実行結果取得・購読）で扱う。

## 型定義

```
data WorkflowId = string
data RunId = string                           // 実行ごとに発行される識別子
data YamlSource = string

data StartedRun =
    Id: RunId
    WorkflowId: WorkflowId
    StartedAt: number

data StartRunError =
    | WorkflowNotFound                        // 指定 WorkflowId が存在しない
    | InvalidYaml of reason: string           // 実行時点の YAML が構文/スキーマ違反
    | UnsupportedNode of nodeType: string     // ランタイム未対応のノード種別を含む
    | RuntimeUnavailable                       // ランタイムが起動していない・接続不可

// dependencies
func readWorkflowFile: WorkflowId -> YamlSource OR NotFound
func parseWorkflowYaml: YamlSource -> WorkflowDocument OR ParseError
func validateRuntimeSupport: WorkflowDocument -> Supported OR UnsupportedNode
func enqueueRun: WorkflowDocument -> RunId OR RuntimeUnavailable
```

## ワークフロー

```
workflow "Start Run" =
  input: WorkflowId
  output:
    RunStarted
    OR WorkflowNotFound
    OR InvalidYaml
    OR UnsupportedNode
    OR RuntimeUnavailable
  dependencies: readWorkflowFile, parseWorkflowYaml, validateRuntimeSupport, enqueueRun

  // step 1
  do LocateWorkflow
  If not found then:
    return WorkflowNotFound
    stop

  // step 2
  do ValidateDocument
  If invalid then:
    return InvalidYaml
    stop

  // step 3
  do CheckRuntimeSupport
  If unsupported node then:
    return UnsupportedNode
    stop

  // step 4
  do DispatchRun
  If runtime unavailable then:
    return RuntimeUnavailable
    stop
  return RunStarted

substep "LocateWorkflow" =
    input: WorkflowId
    output: YamlSource
        OR WorkflowNotFound
    dependencies: readWorkflowFile

    readWorkflowFile(WorkflowId)
    If not found then:
        return WorkflowNotFound
    return YamlSource

substep "ValidateDocument" =
    input: YamlSource
    output: WorkflowDocument
        OR InvalidYaml
    dependencies: parseWorkflowYaml

    parseWorkflowYaml(YamlSource)
    If parse error then:
        return InvalidYaml(reason: parse message)
    If schema violation then:
        return InvalidYaml(reason: schema message)
    return WorkflowDocument

substep "CheckRuntimeSupport" =
    input: WorkflowDocument
    output: Supported
        OR UnsupportedNode
    dependencies: validateRuntimeSupport

    validateRuntimeSupport(WorkflowDocument)
    If unsupported node found then:
        return UnsupportedNode(nodeType: name)
    return Supported

substep "DispatchRun" =
    input: WorkflowDocument
    output: StartedRun
        OR RuntimeUnavailable
    dependencies: enqueueRun

    enqueueRun(WorkflowDocument)
    If runtime unavailable then:
        return RuntimeUnavailable
    return StartedRun
```

## 不変条件

1. 構文エラーのある YAML では実行を開始しない
2. ランタイム未対応ノードを含むワークフローは実行を開始しない
3. RunStarted の RunId は実行ごとに一意
4. ワークフロー本体（YAML 原文）は実行開始によって変更されない
5. 実行開始は非同期であり、進捗・完了は本ワークフローの責務外
