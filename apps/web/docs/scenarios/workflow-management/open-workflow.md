---
status: draft
reviewer:
---

# ワークフロー読み込み

## ストーリー

ユーザが、ファイルツリーまたは URL から特定のワークフローを開き、編集画面で YAML 原文と可視化グラフを確認する。

## 型定義

```
data WorkflowId = string                     // YAMLファイル名
data YamlSource = string                     // YAML原文

data WorkflowDocument =
    Id: WorkflowId
    Name: string
    Yaml: YamlSource
    Graph: FlowGraph                          // ノードとエッジ

data FlowGraph =
    Nodes: FlowNode[]
    Edges: FlowEdge[]
    ParseError: string OR null                // 構文エラー時のメッセージ

data OpenWorkflowError =
    | NotFound                                // 該当 Id のファイルが存在しない

// dependencies
func readWorkflowFile: WorkflowId -> YamlSource OR NotFound
func parseToGraph: YamlSource -> FlowGraph
```

## ワークフロー

```
workflow "Open Workflow" =
  input: WorkflowId
  output:
    WorkflowOpened
    OR NotFound
  dependencies: readWorkflowFile, parseToGraph

  // step 1
  do LocateWorkflow
  If not found then:
    return NotFound
    stop

  // step 2
  do RenderGraph
  return WorkflowOpened

substep "LocateWorkflow" =
    input: WorkflowId
    output: YamlSource
        OR NotFound
    dependencies: readWorkflowFile

    readWorkflowFile(WorkflowId)
    If not found then:
        return NotFound
    return YamlSource

substep "RenderGraph" =
    input: YamlSource
    output: FlowGraph
    dependencies: parseToGraph

    parseToGraph(YamlSource)
    If parse error then:
        return FlowGraph with empty Nodes/Edges and ParseError set
    return FlowGraph
```

## 不変条件

1. YAML が壊れていてもワークフロー自体は開ける（編集して修正できる）
2. 構文エラーがある場合は ParseError にメッセージが入り、Graph は最後に解析成功した状態ではなく空になる
3. 読み込みは副作用を持たない（ファイルを書き換えない）
