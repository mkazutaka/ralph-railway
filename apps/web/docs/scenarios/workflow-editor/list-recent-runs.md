---
status: draft
reviewer:
---

# 直近の実行履歴取得

## ストーリー

ユーザが、特定のワークフローに対する直近の実行履歴一覧をサイドバーで確認する。各履歴には開始時刻・所要時間・状態が含まれる。

## 型定義

```
data WorkflowId = string
data RunId = string

data RunStatus =
    | Pending
    | Running
    | Succeeded
    | Failed
    | Cancelled

data RunSummary =
    Id: RunId
    WorkflowId: WorkflowId
    Status: RunStatus
    StartedAt: number
    DurationMs: number OR null               // 終了していない場合は null

data ListRecentRunsResult =
    | RunList of runs: RunSummary[]          // 0件含む。新しい順
    | WorkflowNotFound

// dependencies
func workflowExists: WorkflowId -> bool
func findRecentRunsByWorkflow: WorkflowId AND Limit: number -> RunSummary[]
```

## ワークフロー

```
workflow "List Recent Runs" =
  input: WorkflowId AND Limit: number
  output:
    RunList
    OR WorkflowNotFound
  dependencies: workflowExists, findRecentRunsByWorkflow

  // step 1
  do EnsureWorkflowExists
  If not exists then:
    return WorkflowNotFound
    stop

  // step 2
  do CollectRecentRuns
  return RunList

substep "EnsureWorkflowExists" =
    input: WorkflowId
    output: Found
        OR WorkflowNotFound
    dependencies: workflowExists

    workflowExists(WorkflowId)
    If not exists then:
        return WorkflowNotFound
    return Found

substep "CollectRecentRuns" =
    input: WorkflowId AND Limit
    output: RunSummary[]
    dependencies: findRecentRunsByWorkflow

    findRecentRunsByWorkflow(WorkflowId, Limit)
    sort by StartedAt descending
    return RunSummary[]
```

## 不変条件

1. 自分が指定したワークフローの履歴のみが返される
2. 結果は新しい順（StartedAt 降順）
3. 0件の場合は空配列で返る（エラーにしない）
4. 実行中（Pending/Running）の Run も一覧に含まれ、DurationMs は null
