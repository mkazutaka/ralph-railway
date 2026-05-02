---
status: draft
reviewer:
---

# 実行詳細取得

## ストーリー

ユーザが、特定の Run を選択して詳細（各ノードの状態・出力・ログ・エラー）を確認する。

## 型定義

```
data RunId = string
data WorkflowId = string
data NodeId = string

data NodeRunStatus =
    | Pending                                 // 未実行
    | Running                                 // 実行中
    | Succeeded                               // 正常完了
    | Failed                                  // エラー終了
    | Skipped                                 // 条件により実行されなかった
    | Cancelled                               // 停止により中断

data NodeRunDetail =
    NodeId: NodeId
    Status: NodeRunStatus
    StartedAt: number OR null
    EndedAt: number OR null
    Output: string OR null                    // .output.<name> 等
    ErrorMessage: string OR null
    LogExcerpt: string                        // 表示用ログ抜粋

data RunDetail =
    Id: RunId
    WorkflowId: WorkflowId
    Status: RunStatus
    StartedAt: number
    EndedAt: number OR null
    Nodes: NodeRunDetail[]                    // ワークフローのノード分

data ReadRunDetailError =
    | RunNotFound

// dependencies
func findRunDetail: RunId -> RunDetail OR NotFound
```

## ワークフロー

```
workflow "Read Run Detail" =
  input: RunId
  output:
    RunDetailRead
    OR RunNotFound
  dependencies: findRunDetail

  // step 1
  do LocateRunDetail
  If not found then:
    return RunNotFound
    stop
  return RunDetailRead

substep "LocateRunDetail" =
    input: RunId
    output: RunDetail
        OR RunNotFound
    dependencies: findRunDetail

    findRunDetail(RunId)
    If not found then:
        return RunNotFound
    return RunDetail
```

## 不変条件

1. 進行中の Run でも詳細を取得できる（一部ノードが Pending/Running のまま）
2. 失敗ノードがある場合、その NodeRunDetail に必ず ErrorMessage が入る
3. ログ全文ではなく抜粋を返す（全文取得は別経路）
4. 詳細取得は副作用を持たない
