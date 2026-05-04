---
status: draft
reviewer:
---

# ワークフロー一覧取得

## ストーリー

ユーザが、設定済みのディレクトリに配置されているワークフロー定義（YAML）の一覧を確認する。各ワークフローは表示用の名前と識別子をもつ。

## 型定義

```
data WorkflowId = string                     // YAMLファイル名（一意）

data WorkflowSummary =
    Id: WorkflowId
    Name: string                             // ドキュメント名（YAMLから抽出）or ファイル名

data ListWorkflowsResult =
    | WorkflowList of workflows: WorkflowSummary[]    // 0件含む

// dependencies
func listWorkflowFiles: void -> WorkflowFile[]
func extractWorkflowSummary: WorkflowFile -> WorkflowSummary
```

## ワークフロー

```
workflow "List Workflows" =
  input: void
  output: WorkflowList
  dependencies: listWorkflowFiles, extractWorkflowSummary

  // step 1
  do CollectWorkflowFiles

  // step 2
  do SummarizeEach
  return WorkflowList

substep "CollectWorkflowFiles" =
    input: void
    output: WorkflowFile[]
    dependencies: listWorkflowFiles

    listWorkflowFiles()
    return WorkflowFile[]

substep "SummarizeEach" =
    input: WorkflowFile[]
    output: WorkflowSummary[]
    dependencies: extractWorkflowSummary

    For each WorkflowFile:
        extractWorkflowSummary(WorkflowFile)
        If extraction failed then:
            fallback Name = file basename
        collect WorkflowSummary
    return WorkflowSummary[]
```

## 不変条件

1. 0件の場合も WorkflowList は空配列で返る（エラーにしない）
2. 各 WorkflowSummary には必ず Name が設定される（YAMLが壊れていてもファイル名で代替）
3. WorkflowId は一意であり、同一一覧内に重複しない
