---
name: smilezemi-exempt-day
description: スマイルゼミ通知システムの「学習免除日(おやすみ)」を登録・取り消しするときに使う。旅行・体調不良・行事などで勉強できない日をストリークの対象外にしたい、その日はおたすけを使わずに記録を守りたい、免除の登録を取り消したいといった依頼で必ずこのスキルを使うこと。未来日付の事前登録にも、既に確定してしまった過去日付の修復にも使える。おたすけ(grace)そのものの増減は smilezemi-set-grace、連続日数(streak)の直接変更は smilezemi-set-streak という別スキルなので、値を直接いじる依頼ではそちらを使う。変更は本番(GitHub Actions キャッシュ)に反映される。
---

# 学習免除日(おやすみ)の登録・取り消し

勉強できない日を「免除日」として登録する。免除日は**未学習でもストリークをリセットせず、おたすけ(grace)も消費しない**。免除日に学習していれば通常どおり加算されるので、登録しておいて損はない。

このスキルは `exempt-days.yml` ワークフローだけを使う。streak / grace / bonus の値を直接書き換えたい依頼には使わない（それぞれ専用スキルがある）。

## 前提

- 実データは GitHub Actions のキャッシュ（`smilezemi-data-*`）にのみ存在し、ローカルには無い。
  そのため確認も変更もすべて `gh` 経由のワークフロー実行で行う。
- 変更は次回のスケジュール通知（夜 20:00 / 朝 7:00）で自動的に反映される。
- 通知ワークフローが動いている時間帯に実行するとキャッシュ保存が後勝ちで競合しうる。
  スケジュールとぶつからない時間帯に実行すること。
- `gh` CLI がこのリポジトリに対して認証済みであること。

## 免除日の制約

- 日付は `YYYY-MM-DD` 形式。`to` を省略すると単日になる。
- 一度に指定できる期間は **31日** まで。
- **過去日付は学習履歴が残っている範囲（直近90日、かつ機能導入後）でのみ修復できる。**
  範囲外の日はスクリプトが中断するので、その場合は `smilezemi-set-streak` /
  `smilezemi-set-grace` スキルで手動調整する。
- 未来日付には制限がない（旅行の予定などを事前に登録できる）。

## 手順

### 1. 対象と期間を確定する

ユーザーに「どの子（全員か）」「いつからいつまで」「登録か取り消しか」を確認する。
家族旅行なら全員、体調不良なら1人であることが多い。

### 2. 現在値と正確なユーザーキーを確認する

ユーザーキーは完全一致が必要で、形式は環境依存（例: `"やまだたろうさん"`）。
推測せず、必ず読み取り専用ワークフローで実際のキーを確認してコピーする:

```bash
gh workflow run show-streak-data.yml
# 起動直後は run が一覧に出ないことがあるため、現れるまで数秒待って取得する
RUN_ID=$(gh run list --workflow=show-streak-data.yml --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$RUN_ID" --exit-status
gh run view "$RUN_ID" --log | grep show-streak-data
```

出力の `"<キー>"` から正確なキーを、`免除日:` から既存の登録を、`直近の履歴:` から
過去日付が修復できる範囲かを読み取る。

### 3. まず dry-run で変更内容を確認する（事故防止）

いきなり保存せず、`dry_run=true` で「変更前→変更後」を確認し、ユーザーに提示して合意を得る:

```bash
gh workflow run exempt-days.yml \
  -f user="<手順2で確認した正確なキー、または __all__>" \
  -f from=<YYYY-MM-DD> \
  -f to=<YYYY-MM-DD> \
  -f action=add \
  -f dry_run=true
RUN_ID=$(gh run list --workflow=exempt-days.yml --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$RUN_ID" --exit-status
gh run view "$RUN_ID" --log | grep set-exempt-dates
```

過去日付の場合は「変更後」の `streak` / `grace` が増えているはずで、これが修復された証拠になる。

### 4. 本番反映する

dry-run の内容で問題なければ、`dry_run` を付けずに（または `false` で）実行して保存する:

```bash
gh workflow run exempt-days.yml \
  -f user="<正確なキー、または __all__>" \
  -f from=<YYYY-MM-DD> \
  -f to=<YYYY-MM-DD> \
  -f action=add
RUN_ID=$(gh run list --workflow=exempt-days.yml --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$RUN_ID" --exit-status
gh run view "$RUN_ID" --log | grep set-exempt-dates
```

取り消しは `-f action=remove` を渡す。取り消すとその日の罰が再適用される点をユーザーに伝えること。

### 5. 結果を報告する

ログの「追加 N件」「変更前: streak=X grace=Y」「変更後: streak=X grace=Y」「保存しました」を確認し、
ユーザーに報告する。実際の通知メッセージには次回のスケジュール実行で反映される旨も伝える。

## 失敗時の対応

- 「対象ユーザーが見つかりません」→ 手順2に戻り、候補一覧から正確なキーをコピーし直す。
- 「学習履歴の範囲外のため修復できません」→ 古すぎる日。`smilezemi-set-streak` /
  `smilezemi-set-grace` スキルで手動調整する。
- 「一度に指定できるのは31日までです」→ 期間を分けて複数回実行する。
- 整合性チェックで中断（既存キャッシュあるのに復元失敗）→ キャッシュサービス異常の可能性。
  時間を置いて再実行する。空データを保存させないための安全機構なので、無理に回避しない。
