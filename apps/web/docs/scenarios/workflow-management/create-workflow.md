---
status: draft
reviewer:
---

# ワークフロー新規作成

## ストーリー

ユーザが、ファイル名と初期 YAML を指定して新しいワークフローを作成する。作成成功後は編集画面に遷移できる状態になる。

## 型定義

```
data WorkflowId = string                     // YAMLファイル名（一意）
data YamlSource = string                     // YAML原文

data CreatedWorkflow =
    Id: WorkflowId
    Name: string

data CreateWorkflowError =
    | InvalidId of reason: string            // 空・パス区切り・拡張子無し等
    | DuplicateId                             // 同名のワークフローが既に存在
    | InvalidYaml of reason: string          // YAML構文エラー or DSLスキーマ違反

// dependencies
func validateWorkflowId: WorkflowId -> Valid OR InvalidId
func parseWorkflowYaml: YamlSource -> WorkflowDocument OR ParseError
func workflowExists: WorkflowId -> bool
func persistWorkflow: WorkflowId AND YamlSource -> CreatedWorkflow
```

## ワークフロー

```
workflow "Create Workflow" =
  input: WorkflowId AND YamlSource
  output:
    WorkflowCreated
    OR InvalidId
    OR DuplicateId
    OR InvalidYaml
  dependencies: validateWorkflowId, parseWorkflowYaml, workflowExists, persistWorkflow

  // step 1
  do ValidateIdentifier
  If id is invalid then:
    return InvalidId
    stop

  // step 2
  do EnsureUnique
  If id already exists then:
    return DuplicateId
    stop

  // step 3
  do ValidateDocument
  If yaml is invalid then:
    return InvalidYaml
    stop

  // step 4
  do PersistWorkflow
  return WorkflowCreated

substep "ValidateIdentifier" =
    input: WorkflowId
    output: Valid
        OR InvalidId
    dependencies: validateWorkflowId

    validateWorkflowId(WorkflowId)
    If empty then:
        return InvalidId(reason: "empty")
    If contains path separator then:
        return InvalidId(reason: "path separator not allowed")
    If extension not yaml/yml then:
        return InvalidId(reason: "must end with .yaml or .yml")
    return Valid

substep "EnsureUnique" =
    input: WorkflowId
    output: Unique
        OR DuplicateId
    dependencies: workflowExists

    workflowExists(WorkflowId)
    If exists then:
        return DuplicateId
    return Unique

substep "ValidateDocument" =
    input: YamlSource
    output: WorkflowDocument
        OR InvalidYaml
    dependencies: parseWorkflowYaml

    parseWorkflowYaml(YamlSource)
    If parse error then:
        return InvalidYaml(reason: parse message)
    If DSL schema violation then:
        return InvalidYaml(reason: schema message)
    return WorkflowDocument

substep "PersistWorkflow" =
    input: WorkflowId AND YamlSource
    output: CreatedWorkflow
    dependencies: persistWorkflow

    persistWorkflow(WorkflowId, YamlSource)
    return CreatedWorkflow
```

## 不変条件

1. 既存のワークフローを上書きしない（DuplicateId で拒否）
2. 不正な YAML はディスクに書き込まれない
3. WorkflowId にディレクトリ区切り文字を含められない（パストラバーサル防止）
4. 作成後は同じ Id で読み出せる
