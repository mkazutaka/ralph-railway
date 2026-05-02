---
status: draft
reviewer:
---

# ワークフロー実行停止

## ストーリー

ユーザが、現在実行中の Run を Stop ボタンから停止する。停止はランタイムへ要求として投入され、停止が完了したかどうかは実行状態の購読で確認する。

## 型定義

```
data RunId = string

data RunStatus =
    | Pending                                 // 投入済み・実行待ち
    | Running                                 // 実行中
    | Succeeded                               // 正常完了
    | Failed                                  // エラー終了
    | Cancelled                               // 停止要求により中断

data StopAccepted =
    Id: RunId
    RequestedAt: number

data StopRunError =
    | RunNotFound                             // 該当 RunId が存在しない、または指定 WorkflowId に紐付かない
    | RunAlreadyTerminal                      // 既に Succeeded/Failed/Cancelled
    | RuntimeUnavailable                      // ランタイムへ要求送信不可

// dependencies
func findRun: RunId -> RunSnapshot OR NotFound
func requestRunStop: RunId -> StopAccepted OR RuntimeUnavailable
```

注: 本シナリオは「呼び出し元の認証が完了している」ことを前提とする。停止操作は破壊的であるため、production 配備では認証する reverse proxy 経由でのみ到達できるようにすること（`apps/web/src/hooks.server.ts` の localhost ガードと ingress secret はその defence-in-depth に過ぎない）。

## ワークフロー

```
workflow "Stop Run" =
  input: RunId AND WorkflowId
  output:
    StopRequested
    OR RunNotFound
    OR RunAlreadyTerminal
    OR RuntimeUnavailable
  dependencies: findRun, requestRunStop

  // step 1
  do LocateRun
  If not found then:
    return RunNotFound
    stop
  If run.workflowId != input.workflowId then:
    return RunNotFound                       // クロスワークフロー隔離
    stop
  If status is terminal then:
    return RunAlreadyTerminal
    stop

  // step 2
  do RequestStop
  If runtime unavailable then:
    return RuntimeUnavailable
    stop
  return StopRequested

substep "LocateRun" =
    input: RunId AND WorkflowId
    output: RunSnapshot
        OR RunNotFound
        OR RunAlreadyTerminal
    dependencies: findRun

    findRun(RunId)
    If not found then:
        return RunNotFound
    If run.workflowId != input.workflowId then:
        return RunNotFound
    If status in {Succeeded, Failed, Cancelled} then:
        return RunAlreadyTerminal
    return RunSnapshot

substep "RequestStop" =
    input: RunId
    output: StopAccepted
        OR RuntimeUnavailable
    dependencies: requestRunStop

    requestRunStop(RunId)
    If runtime unavailable then:
        return RuntimeUnavailable
    return StopAccepted
```

## 不変条件

1. 既に終了状態の Run には停止要求を発行しない
2. 停止は非同期要求であり、本ワークフローの完了は「要求の受理」までを保証する
3. 実際に Cancelled 状態へ遷移したかは別ワークフロー（実行状態購読）で観測する
4. 入力 `WorkflowId` に紐付かない Run は存在しない（`RunNotFound`）として扱う — 別ワークフロー所属の Run id を知っているだけで停止操作が成立しないようにする
5. ランタイムアダプタの `requestRunStop` は冪等に動作すること — 同一 RunId への複数回の停止要求はすべて受理（または `RuntimeUnavailable`）として扱われ、終了済み Run に対する要求も例外を起こさず受理して構わない
