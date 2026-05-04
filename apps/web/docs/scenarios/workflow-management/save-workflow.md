---
status: draft
reviewer:
---

# ワークフロー保存

## ストーリー

編集中のユーザが、現在のワークフロー YAML を明示的に保存する。保存は既存ワークフローへの上書きであり、構文不正な YAML も保存できる（編集途中の状態を残せる）が、ID とパスは検証される。

## 型定義

```
data WorkflowId = string
data YamlSource = string

data SavedWorkflow =
    Id: WorkflowId
    SavedAt: number

data SaveWorkflowError =
    | NotFound                                // 上書き対象のワークフローが存在しない
    | InvalidId of reason: string             // パストラバーサル等
    | StorageFailure                          // ディスク書込失敗（権限・容量等）

// dependencies
func validateWorkflowId: WorkflowId -> Valid OR InvalidId
func workflowExists: WorkflowId -> bool
func writeWorkflowFile: WorkflowId AND YamlSource -> SavedWorkflow OR StorageFailure
```

## ワークフロー

```
workflow "Save Workflow" =
  input: WorkflowId AND YamlSource
  output:
    WorkflowSaved
    OR InvalidId
    OR NotFound
    OR StorageFailure
  dependencies: validateWorkflowId, workflowExists, writeWorkflowFile

  // step 1
  do ValidateIdentifier
  If id is invalid then:
    return InvalidId
    stop

  // step 2
  do EnsureExists
  If not found then:
    return NotFound
    stop

  // step 3
  do WriteContent
  If storage failure then:
    return StorageFailure
    stop
  return WorkflowSaved

substep "ValidateIdentifier" =
    input: WorkflowId
    output: Valid
        OR InvalidId
    dependencies: validateWorkflowId

    validateWorkflowId(WorkflowId)
    If contains path separator then:
        return InvalidId(reason: "path separator not allowed")
    return Valid

substep "EnsureExists" =
    input: WorkflowId
    output: Found
        OR NotFound
    dependencies: workflowExists

    workflowExists(WorkflowId)
    If not exists then:
        return NotFound
    return Found

substep "WriteContent" =
    input: WorkflowId AND YamlSource
    output: SavedWorkflow
        OR StorageFailure
    dependencies: writeWorkflowFile

    writeWorkflowFile(WorkflowId, YamlSource)
    If write error then:
        return StorageFailure
    return SavedWorkflow
```

## 不変条件

1. 保存は上書きであり、新規作成とは別ワークフロー（Create Workflow）に分離されている
2. 構文不正な YAML も保存可能（編集中の状態を保護する）
3. 保存に失敗した場合は元のファイル内容が変わらないことを期待する
4. WorkflowId にディレクトリ区切り文字を含められない
