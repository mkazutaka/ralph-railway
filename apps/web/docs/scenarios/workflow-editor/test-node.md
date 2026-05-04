---
status: draft
reviewer:
---

# 単一ノードのテスト実行

## ストーリー

ユーザが、選択中のノードだけをダミー入力値で単独実行し、出力・ログを右パネルで確認する。ワークフロー全体の実行や永続化された Run には影響しない。

## 型定義

```
data WorkflowId = string
data NodeId = string
data DummyInputs = map<string, any>

data NodeTestResult =
    NodeId: NodeId
    Status: NodeRunStatus                    // Succeeded / Failed のいずれか
    Output: string OR null
    ErrorMessage: string OR null
    LogExcerpt: string
    DurationMs: number

data TestNodeError =
    | WorkflowNotFound
    | NodeNotFound                            // 指定 NodeId がワークフローに存在しない
    | NodeNotTestable                         // 単独テストに対応していないノード種別
    | InvalidInputs of reason: string         // ダミー入力の型不一致など
    | RuntimeUnavailable

// dependencies
func readWorkflowFile: WorkflowId -> YamlSource OR NotFound
func parseWorkflowYaml: YamlSource -> WorkflowDocument OR ParseError
func locateNode: WorkflowDocument AND NodeId -> NodeDefinition OR NotFound
func validateNodeInputs: NodeDefinition AND DummyInputs -> Valid OR InvalidInputs
func executeNodeOnce: NodeDefinition AND DummyInputs -> NodeTestResult OR RuntimeUnavailable
```

## ワークフロー

```
workflow "Test Node" =
  input: WorkflowId AND NodeId AND DummyInputs
  output:
    NodeTested
    OR WorkflowNotFound
    OR NodeNotFound
    OR NodeNotTestable
    OR InvalidInputs
    OR RuntimeUnavailable
  dependencies: readWorkflowFile, parseWorkflowYaml, locateNode, validateNodeInputs, executeNodeOnce

  // step 1
  do LoadWorkflow
  If not found then:
    return WorkflowNotFound
    stop

  // step 2
  do LocateTargetNode
  If node not found then:
    return NodeNotFound
    stop
  If node not testable then:
    return NodeNotTestable
    stop

  // step 3
  do ValidateDummyInputs
  If invalid then:
    return InvalidInputs
    stop

  // step 4
  do ExecuteIsolated
  If runtime unavailable then:
    return RuntimeUnavailable
    stop
  return NodeTested

substep "LoadWorkflow" =
    input: WorkflowId
    output: WorkflowDocument
        OR WorkflowNotFound
    dependencies: readWorkflowFile, parseWorkflowYaml

    readWorkflowFile(WorkflowId)
    If not found then:
        return WorkflowNotFound
    parseWorkflowYaml(YamlSource)
    If parse error then:
        // 構文エラーは InvalidInputs ではなくテスト不可なので NodeNotFound に近いが、
        // 本ワークフローでは事前条件として WorkflowNotFound と区別せず WorkflowNotFound を返す
        return WorkflowNotFound
    return WorkflowDocument

substep "LocateTargetNode" =
    input: WorkflowDocument AND NodeId
    output: NodeDefinition
        OR NodeNotFound
        OR NodeNotTestable
    dependencies: locateNode

    locateNode(WorkflowDocument, NodeId)
    If not found then:
        return NodeNotFound
    If node type does not support isolated execution then:
        return NodeNotTestable
    return NodeDefinition

substep "ValidateDummyInputs" =
    input: NodeDefinition AND DummyInputs
    output: Valid
        OR InvalidInputs
    dependencies: validateNodeInputs

    validateNodeInputs(NodeDefinition, DummyInputs)
    If type mismatch then:
        return InvalidInputs(reason: "type mismatch on <field>")
    If missing required then:
        return InvalidInputs(reason: "missing required <field>")
    return Valid

substep "ExecuteIsolated" =
    input: NodeDefinition AND DummyInputs
    output: NodeTestResult
        OR RuntimeUnavailable
    dependencies: executeNodeOnce

    executeNodeOnce(NodeDefinition, DummyInputs)
    If runtime unavailable then:
        return RuntimeUnavailable
    return NodeTestResult
```

## 不変条件

1. 単独テストはワークフロー本体の Run 履歴に永続化されない
2. テスト実行はファイル（YAML）を変更しない
3. NodeNotTestable のノード（純粋なロジック構造のみのコンテナ等）には事前に拒否する
4. ダミー入力の型不一致は実行前に検出する
