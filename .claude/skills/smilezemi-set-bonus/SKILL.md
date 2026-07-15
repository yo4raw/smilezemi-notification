---
name: smilezemi-set-bonus
description: スマイルゼミ通知システムの「ボーナスポイント(bonus)」を手動で変更するときに使う。子どものボーナスポイントを特定の値に設定したい、ボーナスを訂正・調整したい、支給前に手動でリセット(0)したいといった依頼で必ずこのスキルを使うこと。おたすけ(grace)の変更は smilezemi-set-grace、連続学習日数(streak)の変更は smilezemi-set-streak という別スキルなので、それらの依頼では使わない。変更は本番(GitHub Actions キャッシュ)に反映される。
---

# ボーナスポイント(bonus)手動変更

スマイルゼミ通知システムの `bonus`（おたすけ満タン中に貯まるボーナスポイント）を、
指定ユーザーについて**絶対値**で設定する。

なぜ専用スキルなのか: grace / streak / bonus は別々のスキルに分離してある。このスキルは
**`field=bonus` しか触らない**。取り違えておたすけや連続日数を書き換える事故を防ぐためなので、
このスキルで grace や streak を変更しようとしないこと（それぞれ専用スキルがある）。

## 前提

- 実データは GitHub Actions のキャッシュ（`smilezemi-data-*`）にのみ存在し、ローカルには無い。
  そのため確認も変更もすべて `gh` 経由のワークフロー実行で行う。
- 変更は次回のスケジュール通知（夜 20:00 / 朝 7:00）で自動的に反映される。
- bonus は通常、毎月1日の月次清算（monthly-bonus）で 0 にリセットされてお小遣いとして支給される。
  このスキルはその通常フロー外での手動訂正・手動リセット用。月次清算そのものを回すものではない。
- 通知ワークフローが動いている時間帯に実行するとキャッシュ保存が後勝ちで競合しうる。
  スケジュールとぶつからない時間帯に実行すること。
- `gh` CLI がこのリポジトリに対して認証済みであること。

## bonus の制約

- 範囲は **0 以上の整数**。負値はスクリプト側で拒否される。
- 対象は**既存ユーザーのみ**。未知のキーはスクリプトが候補を提示して中断する（幽霊ユーザー防止）。

## 手順

### 1. 対象と目標値を確定する

ユーザーに「どの子（どのコース）」の bonus を「いくつ」にするか確認する。
bonus は 0 以上の絶対値で指定する（「+1」ではなく「5 にする」の形）。

### 2. 現在値と正確なユーザーキーを確認する

ユーザーキーは `"名前 (コース名)"` 形式で、完全一致が必要。読み取り専用ワークフローで確認する:

```bash
gh workflow run show-streak-data.yml
# 起動直後は run が一覧に出ないことがあるため、現れるまで数秒待って取得する
RUN_ID=$(gh run list --workflow=show-streak-data.yml --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$RUN_ID" --exit-status
gh run view "$RUN_ID" --log | grep show-streak-data
```

出力の `"名前 (コース名)": ... bonus=...` から、正確なキーと現在の bonus を読み取る。

### 3. まず dry-run で変更内容を確認する（事故防止）

いきなり保存せず、`dry_run=true` で「変更前→変更後」を確認し、ユーザーに提示して合意を得る:

```bash
gh workflow run adjust-streak-field.yml \
  -f field=bonus \
  -f user="<手順2で確認した正確なキー>" \
  -f value=<0以上> \
  -f dry_run=true
RUN_ID=$(gh run list --workflow=adjust-streak-field.yml --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$RUN_ID" --exit-status
gh run view "$RUN_ID" --log | grep set-streak-field
```

`field` は必ず `bonus` を渡す（このスキルの責務）。

### 4. 本番反映する

dry-run の内容で問題なければ、`dry_run` を付けずに（または `false` で）実行して保存する:

```bash
gh workflow run adjust-streak-field.yml \
  -f field=bonus \
  -f user="<正確なキー>" \
  -f value=<0以上>
RUN_ID=$(gh run list --workflow=adjust-streak-field.yml --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$RUN_ID" --exit-status
gh run view "$RUN_ID" --log | grep set-streak-field
```

### 5. 結果を報告する

ログの「変更前: bonus=X」「変更後: bonus=Y」「保存しました」を確認し、ユーザーに報告する。
実際の通知メッセージには次回のスケジュール実行で反映される旨も伝える。

## 失敗時の対応

- 「対象ユーザーが見つかりません」→ 手順2に戻り、候補一覧から正確なキーをコピーし直す。
- 「bonus は 0 以上 の範囲で…」→ 指定値を 0 以上にする。
- 整合性チェックで中断（既存キャッシュあるのに復元失敗）→ キャッシュサービス異常の可能性。
  時間を置いて再実行する。空データを保存させないための安全機構なので、無理に回避しない。
