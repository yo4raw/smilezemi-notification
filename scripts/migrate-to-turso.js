#!/usr/bin/env node
/**
 * actions/cache に残っている data/*.json を Turso に投入する使い捨ての移行スクリプト。
 *
 * 本番の streak_data.json は actions/cache 内にのみ存在し、キャッシュには公開
 * ダウンロードAPIがないため、このスクリプトは .github/workflows/migrate-to-turso.yml
 * から実行する(キャッシュを復元した直後の data/ を読む)。
 *
 * 二重実行の事故を防ぐため、既に app_state に該当キーの行があれば上書きしない。
 * 上書きは --force を明示したときだけ。
 *
 * 【最重要】1回きり・失敗すると翌JST7:00の朝通知で不可逆の被害が出る:
 *   createSchema()はテーブル2つとトリガー2つを1リクエストで作るが、Tursoの
 *   pipelineは文ごとに独立実行されるため、create tableが成功してtrigger作成が
 *   失敗しても{success:false}が返るだけでテーブルは実在してしまう。この状態だと
 *   以後readStateは'uninitialized'ではなく'empty'を返し、朝通知の安全装置
 *   (uninitializedチェック)が素通りして全ユーザーが新規扱いになり、
 *   streak/grace/bonus(現金)が消える。そのためこのスクリプトは
 *   (1) ファイルの読み込み・parse・正規化を全件済ませてからでないとcreateSchema
 *       を呼ばない(ファイル欠落やJSON破損ではテーブルを作らない)
 *   (2) createSchema失敗時、およびcreateSchema成功後にstreak_dataを投入できずに
 *       失敗した場合(既存確認の失敗・書き込みの失敗)は、実際のテーブル/行の有無を
 *       readStateで確認し、危険な場合は運用者に翌朝7時までの対応を明示する
 *   (3) 書き込み後にラウンドトリップ照合と本番の読み出し経路での検証を行い、
 *       空データを成功として通さない
 * という設計にしている。
 *
 * 移行が完了したらこのスクリプトとワークフローは削除する。
 *
 * 使い方:
 *   node scripts/migrate-to-turso.js [--force]
 *   (--force は値なしで指定する。`--force true` のような値付きはエラーで止める)
 */

const fs = require('fs').promises;
const path = require('path');

const { createSchema, readState, writeState, sanitizeParseError } = require('../src/store');
const { loadStreakData } = require('../src/streak');
const { loadPreviousData } = require('../src/data');

const DATA_DIR = path.join(__dirname, '../data');

// ファイル名 → Turso上のキー
const TARGETS = [
  { file: 'streak_data.json', key: 'streak_data' },
  { file: 'mission_data.json', key: 'mission_data' }
];

/**
 * `--force` のようなフラグを素朴にパースする
 *
 * 値付きトークン(`--force true`)は文字列として拾う。真偽フラグとしての解釈は
 * resolveForce() が担い、値付きの --force はそこで拒否する。
 *
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {Record<string, string|boolean>}
 */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

/**
 * ユーザー名を伏せる
 *
 * 公開リポジトリのワークフローログに実名を出さないため、末尾1文字だけ残す
 * (src/crawler.js の maskName と同じ方針)。
 *
 * @param {string} name
 * @returns {string}
 */
function maskUserName(name) {
  if (!name || name.length <= 1) {
    return name;
  }
  return '*'.repeat(name.length - 1) + name.slice(-1);
}

/**
 * 「app_state テーブルが実在し、streak_data の行が無い」危険状態の共通文面。
 *
 * この状態は readState('streak_data') が 'uninitialized' ではなく 'empty' を返すため、
 * 朝通知の安全装置(uninitializedならストリーク確定をスキップ)が素通りして
 * 全ユーザーが新規扱いになる。createSchema()が失敗した場合(トリガー作成だけ失敗)と、
 * createSchema()成功後にstreak_dataを投入できなかった場合の両方で起こりうるため、
 * 文面を1つに集約する。
 *
 * @param {string} stateLabel - probeで観測したstate(または「確認不能(理由)」)
 * @returns {string}
 * @private
 */
function dangerousGapMessage(stateLabel) {
  return `🚨🚨🚨 [migrate-to-turso] 危険: app_state テーブルは作成済みで、streak_data の行がない状態です(state=${stateLabel})。\n`
    + 'このまま翌JST 7:00の朝通知が実行されると、Turso側が"初回実行"と誤認され'
    + '全ユーザーの streak / grace / bonus が新規状態で上書きされます(復元手段はありません)。\n'
    + '【今すぐ行うこと】\n'
    + '  1. 原因(トリガー作成の失敗・ネットワーク障害など)を調査する\n'
    + '  2. 翌朝7:00までに本スクリプトを再実行して streak_data / mission_data の投入を完了させる\n'
    + '  3. 翌朝7:00までに間に合わない場合は morning-crawler ワークフローを一時的に無効化する\n'
    + '  4. 既に朝通知が走ってしまった場合は app_state に行ができているため、'
    + '再実行が「既に存在します(スキップ)」になる。上書きして正しい値を投入するには --force が必要';
}

/**
 * createSchema()失敗時に、実際に危険な状態(テーブルが作成済みの可能性)かを
 * probe(readStateの結果)から判定し、運用者への具体的なメッセージを組み立てる。
 *
 * Tursoのpipelineは文ごとに独立実行されるため、create table群の一部が成功して
 * trigger作成などの後続文だけが失敗しても{success:false}が返る。この場合、
 * readState('streak_data')は'uninitialized'ではなく'empty'(またはそれ以外)を
 * 返すようになる。'uninitialized'のままなら何も作られていない安全な状態。
 *
 * @param {string} schemaError - createSchema()が返したerror
 * @param {{success: boolean, state?: string, error?: string}} probe - readStateの結果
 * @returns {{dangerous: boolean, message: string}}
 */
function describeSchemaFailure(schemaError, probe) {
  const header = `スキーマ作成に失敗しました: ${schemaError}`;

  if (probe.success && probe.state === 'uninitialized') {
    return {
      dangerous: false,
      message: `${header}\n`
        + '[migrate-to-turso] テーブルは作成されていません(uninitialized)。安全な状態のまま中断しました。'
        + '原因を解消してから再実行してください。'
    };
  }

  // 行が既にある(state=ok)場合、朝通知は既存値を読むため0リセットは起きない。
  // ただしトリガーなどスキーマが不完全な可能性があるので放置はできない
  if (probe.success && probe.state === 'ok') {
    return {
      dangerous: true,
      message: `${header}\n`
        + '⚠️ [migrate-to-turso] app_state に streak_data の行が既に存在します(state=ok)。'
        + '行があるため朝通知でストリークが0にリセットされることはありません。'
        + 'ただしトリガーなどスキーマが不完全な可能性があるため、原因を調査して再実行してください'
        + '(既存値を上書きして投入し直す場合のみ --force を付けます)。'
    };
  }

  // probe.success===false(接続不能など)は「テーブルが無い」と確認できていないだけであり、
  // 「ある」とも断定できない。判断がつかない以上、安全側に倒して危険とみなす。
  const stateLabel = probe.success ? probe.state : `確認不能(${probe.error})`;
  return {
    dangerous: true,
    message: `${header}\n${dangerousGapMessage(stateLabel)}`
  };
}

/**
 * createSchema()が成功した後に、streak_dataを投入できずに失敗したときの危険度を
 * probe(readStateの結果)から判定する。
 *
 * この経路(既存確認の一過性失敗 / writeStateのリトライ後の失敗)は
 * 「app_stateが実在し、streak_data行が無い」というファイル冒頭のコメントが
 * 最重要として警告している状態そのものになりうる。createSchema失敗時と同じ
 * 🚨 文面で、翌朝7:00までの対応と --force の必要性を運用者に伝える。
 *
 * @param {string} baseError - 失敗そのものの説明(既存確認の失敗・書き込みの失敗)
 * @param {{success: boolean, state?: string, error?: string}} probe - readState('streak_data')の結果
 * @returns {{dangerous: boolean, message: string}}
 */
function describePostSchemaFailure(baseError, probe) {
  if (probe.success && probe.state === 'ok') {
    return {
      dangerous: false,
      message: `${baseError}\n`
        + '[migrate-to-turso] app_state に streak_data の行は存在します(state=ok)。'
        + '朝通知が新規扱いで上書きする状態ではありません。原因を解消してから再実行してください'
        + '(既存値を上書きして投入し直す場合のみ --force を付けます)。'
    };
  }

  if (probe.success && probe.state === 'uninitialized') {
    return {
      dangerous: false,
      message: `${baseError}\n`
        + '[migrate-to-turso] app_state テーブルが存在しません(uninitialized)。'
        + 'スキーマ作成は成功したはずなので想定外ですが、テーブルが無い間は朝通知が'
        + 'ストリークの確定処理をスキップするため上書き被害は起きません。'
        + '原因を解消してから再実行してください。'
    };
  }

  const stateLabel = probe.success ? probe.state : `確認不能(${probe.error})`;
  return {
    dangerous: true,
    message: `${baseError}\n${dangerousGapMessage(stateLabel)}`
  };
}

/**
 * 投入対象にstreak_dataが含まれているかを判定する。
 *
 * streak_data.jsonが無いままcreateSchema()を呼ぶと、テーブルだけ存在して
 * streak_data行が無い状態(readStateが'uninitialized'ではなく'empty'を返す)に
 * なり、朝通知の安全装置が素通りして全ユーザーが新規扱いになる。ワークフロー側の
 * ファイル存在チェックが通常の防波堤だが、スクリプト単体でも最後の防波堤として
 * これを保証する。
 *
 * @param {Array<{key: string}>} prepared - 読み込み・parseに成功したTARGETSのサブセット
 * @returns {boolean}
 */
function hasStreakData(prepared) {
  return prepared.some(target => target.key === 'streak_data');
}

/**
 * 書き込んだ内容と読み戻した内容が一致するかを判定する(ラウンドトリップ照合)。
 *
 * @param {string} key - Turso上のキー(ログ用)
 * @param {string} written - 書き込んだJSON文字列
 * @param {string|null} readBack - readStateで読み戻した値(state!=='ok'ならnull)
 * @returns {{ok: boolean, message: string}}
 */
function compareRoundTrip(key, written, readBack) {
  if (typeof readBack !== 'string') {
    return {
      ok: false,
      message: `[migrate-to-turso] ${key} を書き込んだのに読み戻せませんでした(値が存在しません)`
    };
  }
  if (readBack !== written) {
    return {
      ok: false,
      message: `[migrate-to-turso] ${key} の読み戻し内容が書き込み内容と一致しません`
        + `(書込${written.length}文字 / 読戻${readBack.length}文字)`
    };
  }
  return {
    ok: true,
    message: `[migrate-to-turso] ${key}: 書き込み内容と読み戻し内容が一致しました (${readBack.length}文字)`
  };
}

/**
 * 1ユーザー分のストリーク状態を表示用の1行に整形する(実名はマスクする)。
 *
 * @param {string} key - ユーザーキー(実名)
 * @param {object} [state] - ユーザーのストリーク状態(存在しない場合に備えデフォルトを補う)
 * @returns {string}
 */
function formatUserSummaryLine(key, state) {
  const s = state ?? {};
  return `  - "${maskUserName(key)}": streak=${s.streak} grace=${s.grace} bonus=${s.bonus ?? 0}`
    + ` course=${s.course ?? '(未設定)'} lastConfirmedDate=${s.lastConfirmedDate ?? 'null'}`
    + ` 履歴${Object.keys(s.history ?? {}).length}日 免除${(s.exemptDates ?? []).length}日`;
}

/**
 * 1ファイルを読む。存在しなければ null を返す
 * @private
 */
async function readLocalJson(fileName) {
  const filePath = path.join(DATA_DIR, fileName);
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * --force で上書きする前に、Turso側の既存値を表示する。
 *
 * readState()はvalueしか返さずupdated_atを取得できないため、更新日時は
 * 表示できない(state_auditテーブルに書き込み履歴として残っている)。
 *
 * @param {string} key
 * @param {string} rawValue - 上書き前にTursoに入っていた値
 * @private
 */
function warnBeforeOverwrite(key, rawValue) {
  console.warn(`[migrate-to-turso] --force により "${key}" の既存値を上書きします。上書き前の内容:`);
  if (key === 'streak_data') {
    try {
      const parsed = JSON.parse(rawValue);
      const users = parsed.users ?? {};
      const keys = Object.keys(users);
      console.warn(`[migrate-to-turso]   version=${parsed.version} ユーザー${keys.length}件`);
      keys.forEach(k => console.warn(formatUserSummaryLine(k, users[k])));
    } catch (error) {
      console.warn(`[migrate-to-turso]   既存値のJSON解析に失敗しました(そのまま上書きします): ${sanitizeParseError(error.message)}`);
    }
  } else {
    console.warn(`[migrate-to-turso]   ${rawValue.length}文字(mission_dataは件数のみ表示)`);
  }
  console.warn(
    '[migrate-to-turso]   注: updated_at は readState() では取得できないため表示していません'
    + '(Turso側のstate_auditテーブルに書き込み履歴として残っています)'
  );
}

/**
 * createSchema()成功後の失敗を、危険度の判定込みで戻り値に組み立てる。
 *
 * streak_dataが投入済みなら朝通知が新規扱いで上書きする余地はないので、そのまま返す。
 * まだ投入できていない場合だけ readState('streak_data') で実際の行の有無をprobeし、
 * 危険なら 🚨 文面(翌朝7:00までの対応・--forceの必要性)を error に載せる。
 *
 * @param {string} baseError - 失敗そのものの説明
 * @param {{migrated: string[], skipped: string[], writtenContent: Record<string,string>}} progress
 * @returns {Promise<{success: false, migrated: string[], skipped: string[], writtenContent: Record<string,string>, schemaCreated: true, dangerous?: boolean, error: string}>}
 * @private
 */
async function failAfterSchema(baseError, progress) {
  const { migrated, skipped, writtenContent } = progress;
  const base = { success: false, migrated, skipped, writtenContent, schemaCreated: true };

  if (migrated.includes('streak_data')) {
    return { ...base, error: baseError };
  }

  const probe = await readState('streak_data');
  const { dangerous, message } = describePostSchemaFailure(baseError, probe);
  return { ...base, dangerous, error: message };
}

/**
 * 移行を実行する
 *
 * @param {object} [options]
 * @param {boolean} [options.force=false] - 既存の行を上書きするか
 * @returns {Promise<{success: boolean, migrated: string[], skipped: string[], schemaCreated: boolean, writtenContent?: Record<string,string>, dangerous?: boolean, error?: string}>}
 */
async function migrate(options = {}) {
  const { force = false } = options;
  const migrated = [];
  const skipped = [];
  const writtenContent = {};

  // ステップ1: 全ファイルを先に読み・parse・normalizeする。
  // createSchema()より前に済ませることで、ファイル欠落やJSON破損の場合は
  // 絶対にテーブルを作らない(危険なパスを事前に消す)。
  const prepared = [];
  for (const target of TARGETS) {
    const content = await readLocalJson(target.file);
    if (content === null) {
      console.warn(`[migrate-to-turso] ${target.file} が見つかりません(スキップ)`);
      skipped.push(target.key);
      continue;
    }

    let normalized;
    try {
      normalized = JSON.stringify(JSON.parse(content));
    } catch (error) {
      // createSchema()より前なのでテーブルは作られていない(schemaCreated:false)
      return {
        success: false,
        migrated,
        skipped,
        schemaCreated: false,
        error: `${target.file} のJSONが壊れています: ${sanitizeParseError(error.message)}`
      };
    }

    prepared.push({ ...target, normalized });
  }

  if (prepared.length === 0) {
    console.warn('[migrate-to-turso] 投入対象のファイルが1件もありません。スキーマは作成しません');
    return { success: true, migrated, skipped, schemaCreated: false, writtenContent };
  }

  // streak_dataが無いままcreateSchema()を呼ぶと、テーブルだけ存在してstreak_data行が
  // 無い危険な状態になる(ファイルヘッダのコメント参照)。ワークフロー側のファイル存在
  // チェックが通常の防波堤だが、スクリプト単体でも最後の防波堤として保証する。
  if (!hasStreakData(prepared)) {
    console.error('[migrate-to-turso] streak_data.json が読み込めていません。安全のためスキーマを作成せず中断します');
    return {
      success: false,
      migrated,
      skipped,
      schemaCreated: false,
      error: 'streak_data.json が無いため中断しました(mission_dataだけでcreateSchemaを呼ぶと、'
        + 'streak_data行の無いテーブルができてしまい危険です)'
    };
  }

  console.log('[migrate-to-turso] スキーマを作成しています...');
  const schemaResult = await createSchema();
  if (!schemaResult.success) {
    // 先行文(create table)がコミット済みの可能性があるため、実際の状態を確認してから
    // 危険度に応じたメッセージを組み立てる
    const probe = await readState('streak_data');
    const { dangerous, message } = describeSchemaFailure(schemaResult.error, probe);
    return { success: false, migrated, skipped, schemaCreated: false, error: message, dangerous };
  }
  console.log('[migrate-to-turso] スキーマの作成が完了しました');

  for (const target of prepared) {
    const existing = await readState(target.key);
    if (!existing.success) {
      // ここはテーブルが実在した状態での失敗なので、危険度をprobeで判定する
      return await failAfterSchema(
        `${target.key} の既存確認に失敗しました: ${existing.error}`,
        { migrated, skipped, writtenContent }
      );
    }

    if (existing.state === 'ok' && !force) {
      console.warn(`[migrate-to-turso] ${target.key} は既に存在します。上書きするには --force を付けてください(スキップ)`);
      skipped.push(target.key);
      continue;
    }

    if (existing.state === 'ok' && force) {
      warnBeforeOverwrite(target.key, existing.value);
    }

    const writeResult = await writeState(target.key, target.normalized);
    if (!writeResult.success) {
      // 同上。streak_dataが未投入のままここに来ると最も危険な状態になりうる
      return await failAfterSchema(
        `${target.key} の書き込みに失敗しました: ${writeResult.error}`,
        { migrated, skipped, writtenContent }
      );
    }

    console.log(`[migrate-to-turso] ${target.key} を投入しました (${target.normalized.length}文字)`);
    migrated.push(target.key);
    writtenContent[target.key] = target.normalized;
  }

  return { success: true, migrated, skipped, schemaCreated: true, writtenContent };
}

/**
 * --force の指定を厳密に解釈する。
 *
 * parseArgs は値付きトークンを拾うため `--force true` は args.force === 'true'
 * (文字列)になる。これを黙って「forceなし」に倒すと、--forceを打ったのに上書きが
 * 効かない取り違えが起きる。C1の復旧経路(朝通知が走ってしまい、時間に追われて
 * --force を打つ場面)で最も起きてはいけない誤動作なので、値付きは受け付けず
 * エラーで止める(`--force false` を真に解釈してしまう逆の事故も同時に防ぐ)。
 *
 * @param {Record<string, string|boolean>} args - parseArgs の戻り値
 * @returns {{ok: boolean, force: boolean, error?: string}}
 */
function resolveForce(args) {
  if (!Object.prototype.hasOwnProperty.call(args, 'force')) {
    return { ok: true, force: false };
  }
  if (args.force === true) {
    return { ok: true, force: true };
  }
  return {
    ok: false,
    force: false,
    error: '[migrate-to-turso] --force に値を付けないでください'
      + `(受け取った値: "${args.force}")。上書きするときは値なしの --force だけを指定します`
  };
}

/**
 * 失敗時に運用者へ出す追加の案内を組み立てる(純粋関数)。
 *
 * 「この時点ではTursoに何も投入されていません」は schemaCreated が false の
 * ときだけ出す。createSchema が成功した後の失敗でこの文を出すと、
 * 「app_stateが実在し streak_data 行が無い」という最も危険な状態を
 * 「安全」と誤報することになる(C1)。
 *
 * @param {{migrated: string[], schemaCreated?: boolean, dangerous?: boolean}} result - migrate()の戻り値
 * @returns {string[]} 出力する行
 */
function buildFailureAdvice(result) {
  const lines = [];

  if (result.migrated.length > 0) {
    lines.push(
      `[migrate-to-turso] 注意: ${result.migrated.join(', ')} は投入済みです。`
      + '残りの原因を解消し、必要なら --force で再実行してください。'
    );
  } else if (!result.schemaCreated) {
    lines.push('[migrate-to-turso] この時点ではTursoに何も投入されていません。原因を解消してから再実行してください。');
  }

  if (result.dangerous) {
    lines.push('[migrate-to-turso] 🚨 上記のとおり危険な状態です。翌JST7:00までに対応してください。');
  }

  return lines;
}

/**
 * 投入結果を読み戻して照合する(実名はマスクする)。
 *
 * 1. ラウンドトリップ照合: 今回書き込んだキーだけ、書いた文字列と読み戻した文字列を比較する
 * 2. 本番の読み出し経路(loadStreakData / loadPreviousData)で実際に読めるかを確認する
 *    (version不正などproduction側が拒否する条件をここで検出するため)
 * 3. streak_dataのユーザーが0件なら失敗として扱う(空データを成功として通さない)
 *
 * @param {{writtenContent?: Record<string,string>}} migrateResult - migrate()の戻り値
 * @returns {Promise<boolean>}
 * @private
 */
async function verify(migrateResult) {
  console.log('[migrate-to-turso] 読み戻して照合します');
  const writtenContent = migrateResult.writtenContent ?? {};

  for (const key of Object.keys(writtenContent)) {
    const raw = await readState(key);
    if (!raw.success) {
      console.error(`[migrate-to-turso] ${key} の読み戻しに失敗しました: ${raw.error}`);
      return false;
    }
    const { ok, message } = compareRoundTrip(key, writtenContent[key], raw.state === 'ok' ? raw.value : null);
    if (!ok) {
      console.error(message);
      return false;
    }
    console.log(message);
  }

  const streakResult = await loadStreakData();
  if (!streakResult.success) {
    console.error(`[migrate-to-turso] streak_data を本番の読み出し経路(loadStreakData)で読めませんでした: ${sanitizeParseError(streakResult.error)}`);
    return false;
  }

  const users = streakResult.data ?? {};
  const keys = Object.keys(users);
  if (keys.length === 0) {
    console.error(
      '[migrate-to-turso] streak_data にユーザーが0件です。'
      + 'このまま朝通知が実行されると全ユーザーが新規扱いになる恐れがあるため、失敗として扱います。'
    );
    return false;
  }

  console.log(`[migrate-to-turso] streak_data: ユーザー${keys.length}件 (本番の読み出し経路で確認済み)`);
  keys.forEach(key => console.log(formatUserSummaryLine(key, users[key])));

  // mission_dataはloadPreviousData()が「未投入(空)」と「読み込み失敗」をsuccessで
  // 区別してくれるため、失敗(success:false)だけをエラーとして扱う
  const missionResult = await loadPreviousData();
  if (missionResult.uninitialized) {
    console.error('[migrate-to-turso] mission_data: Tursoが未初期化と判定されました(想定外です。createSchemaは成功しているはずです)');
    return false;
  }
  if (!missionResult.success) {
    console.error(`[migrate-to-turso] mission_data を本番の読み出し経路(loadPreviousData)で読めませんでした: ${sanitizeParseError(missionResult.error)}`);
    return false;
  }

  const missionUsers = missionResult.data ?? [];
  if (missionUsers.length === 0) {
    console.warn('[migrate-to-turso] mission_data はユーザー0件です(未投入、または元データが空)');
  } else {
    console.log(`[migrate-to-turso] mission_data: ユーザー${missionUsers.length}件 (本番の読み出し経路で確認済み)`);
  }

  return true;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const forceOption = resolveForce(args);
  if (!forceOption.ok) {
    console.error(forceOption.error);
    process.exitCode = 1;
    return;
  }
  const force = forceOption.force;

  if (force) {
    console.warn('[migrate-to-turso] --force が指定されました。既存の値を上書きします');
  }

  const result = await migrate({ force });

  if (!result.success) {
    console.error(`[migrate-to-turso] 移行に失敗しました: ${result.error}`);
    buildFailureAdvice(result).forEach(line => console.error(line));
    process.exitCode = 1;
    return;
  }

  console.log(`[migrate-to-turso] 投入: ${result.migrated.length > 0 ? result.migrated.join(', ') : '(なし)'}`);
  console.log(`[migrate-to-turso] スキップ: ${result.skipped.length > 0 ? result.skipped.join(', ') : '(なし)'}`);

  // 今回書き込んだキーが1つもない場合(ローカルにファイルが無い、既存値をスキップした)は
  // 照合するものがない。ここでverifyを走らせるとTursoが未初期化のまま
  // 「照合に失敗しました」と誤報するため、明示的にスキップする
  if (Object.keys(result.writtenContent ?? {}).length === 0) {
    console.warn(
      '[migrate-to-turso] 今回Tursoに書き込んだキーはないため照合(verify)を行いません'
      + '(投入対象のファイルが無い、または既存値があってスキップしました)。'
      + '移行が完了しているかは上の「投入」「スキップ」の行で確認してください。'
    );
    return;
  }

  const verified = await verify(result);
  if (!verified) {
    console.error(
      '[migrate-to-turso] 🚨 照合に失敗しました。書き込みは成功と報告されましたが、内容が正しく読み出せない状態です。'
    );
    console.error(
      '[migrate-to-turso] 🚨 このまま放置すると翌JST7:00の朝通知が不正確なデータで実行される恐れがあります。'
      + '原因を調査し、必要なら --force で再実行してください。'
    );
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch(error => {
    // main()内で捕捉されなかった例外がスタックトレースのまま落ちるのを防ぐ
    console.error(`[migrate-to-turso] 予期しないエラーで停止しました: ${error && error.stack ? error.stack : error}`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  resolveForce,
  maskUserName,
  migrate,
  describeSchemaFailure,
  describePostSchemaFailure,
  buildFailureAdvice,
  compareRoundTrip,
  formatUserSummaryLine,
  hasStreakData
};
