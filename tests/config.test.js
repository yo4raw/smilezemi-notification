/**
 * 環境変数管理とシークレット処理のテスト
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 9.1, 9.2, 9.3, 9.4
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { loadConfig, validateSecrets, maskSensitiveData, maskLiterals } = require('../src/config');

describe('環境変数管理', () => {
  let originalEnv;

  beforeEach(() => {
    // 元の環境変数を保存
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    // 環境変数を復元
    process.env = originalEnv;
  });

  describe('loadConfig', () => {
    it('全ての必須環境変数が存在する場合、設定オブジェクトを返す', () => {
      process.env.SMILEZEMI_USERNAME = 'testuser';
      process.env.SMILEZEMI_PASSWORD = 'testpass';
      process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test_token';
      process.env.LINE_USER_ID = 'U1234567890';
      process.env.TURSO_DATABASE_URL = 'libsql://test-db.turso.io';
      process.env.TURSO_AUTH_TOKEN = 'test-auth-token';

      const config = loadConfig();

      assert.strictEqual(config.SMILEZEMI_USERNAME, 'testuser');
      assert.strictEqual(config.SMILEZEMI_PASSWORD, 'testpass');
      assert.strictEqual(config.LINE_CHANNEL_ACCESS_TOKEN, 'test_token');
      assert.strictEqual(config.LINE_USER_ID, 'U1234567890');
    });

    it('環境変数が欠落している場合、エラーをスローする', () => {
      delete process.env.SMILEZEMI_USERNAME;
      delete process.env.SMILEZEMI_PASSWORD;
      delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
      delete process.env.LINE_USER_ID;

      assert.throws(() => {
        loadConfig();
      }, {
        name: 'Error',
        message: /必須環境変数が設定されていません/
      });
    });

    it('一部の環境変数が欠落している場合、欠落した変数名を含むエラーをスローする', () => {
      process.env.SMILEZEMI_USERNAME = 'testuser';
      // その他は設定しない

      assert.throws(() => {
        loadConfig();
      }, {
        name: 'Error',
        message: /SMILEZEMI_PASSWORD/
      });
    });

    it('DISCORD_WEBHOOK_URLが設定されていれば設定オブジェクトに含める', () => {
      process.env.SMILEZEMI_USERNAME = 'testuser';
      process.env.SMILEZEMI_PASSWORD = 'testpass';
      process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test_token';
      process.env.LINE_USER_ID = 'U1234567890';
      process.env.TURSO_DATABASE_URL = 'libsql://test-db.turso.io';
      process.env.TURSO_AUTH_TOKEN = 'test-auth-token';
      process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/123/abc';

      const config = loadConfig();

      assert.strictEqual(config.DISCORD_WEBHOOK_URL, 'https://discord.com/api/webhooks/123/abc');
    });

    it('DISCORD_WEBHOOK_URLは任意: 未設定でもエラーにならずundefinedになる', () => {
      process.env.SMILEZEMI_USERNAME = 'testuser';
      process.env.SMILEZEMI_PASSWORD = 'testpass';
      process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test_token';
      process.env.LINE_USER_ID = 'U1234567890';
      process.env.TURSO_DATABASE_URL = 'libsql://test-db.turso.io';
      process.env.TURSO_AUTH_TOKEN = 'test-auth-token';
      delete process.env.DISCORD_WEBHOOK_URL;

      const config = loadConfig();

      assert.strictEqual(config.DISCORD_WEBHOOK_URL, undefined);
    });

    it('DISCORD_WEBHOOK_URLが空文字なら未設定扱い(undefined)にする', () => {
      process.env.SMILEZEMI_USERNAME = 'testuser';
      process.env.SMILEZEMI_PASSWORD = 'testpass';
      process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test_token';
      process.env.LINE_USER_ID = 'U1234567890';
      process.env.TURSO_DATABASE_URL = 'libsql://test-db.turso.io';
      process.env.TURSO_AUTH_TOKEN = 'test-auth-token';
      process.env.DISCORD_WEBHOOK_URL = '   ';

      const config = loadConfig();

      assert.strictEqual(config.DISCORD_WEBHOOK_URL, undefined);
    });
  });

  describe('validateSecrets', () => {
    it('全てのシークレットが存在する場合、trueを返す', () => {
      const secrets = {
        SMILEZEMI_USERNAME: 'testuser',
        SMILEZEMI_PASSWORD: 'testpass',
        LINE_CHANNEL_ACCESS_TOKEN: 'token',
        LINE_USER_ID: 'userid',
        TURSO_DATABASE_URL: 'libsql://test-db.turso.io',
        TURSO_AUTH_TOKEN: 'test-auth-token'
      };

      const result = validateSecrets(secrets);
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.missing.length, 0);
    });

    it('シークレットが欠落している場合、falseと欠落リストを返す', () => {
      const secrets = {
        SMILEZEMI_USERNAME: 'testuser'
        // 他は設定しない
      };

      const result = validateSecrets(secrets);
      assert.strictEqual(result.valid, false);
      assert.ok(result.missing.includes('SMILEZEMI_PASSWORD'));
      assert.ok(result.missing.includes('LINE_CHANNEL_ACCESS_TOKEN'));
      assert.ok(result.missing.includes('LINE_USER_ID'));
    });

    it('空文字列のシークレットは無効として扱う', () => {
      const secrets = {
        SMILEZEMI_USERNAME: '',
        SMILEZEMI_PASSWORD: 'testpass',
        LINE_CHANNEL_ACCESS_TOKEN: 'token',
        LINE_USER_ID: 'userid'
      };

      const result = validateSecrets(secrets);
      assert.strictEqual(result.valid, false);
      assert.ok(result.missing.includes('SMILEZEMI_USERNAME'));
    });
  });

  describe('maskSensitiveData', () => {
    it('ログメッセージ内の password= / token= の値を伏せる', () => {
      const masked = maskSensitiveData('Logging in with password=secretpass123 and token=mytoken456');

      assert.ok(!masked.includes('secretpass123'));
      assert.ok(!masked.includes('mytoken456'));
      assert.strictEqual(masked, 'Logging in with password=*** and token=***');
    });

    it('文字列以外はそのまま返す', () => {
      assert.strictEqual(maskSensitiveData(undefined), undefined);
      assert.strictEqual(maskSensitiveData(42), 42);
    });
  });

  describe('maskLiterals', () => {
    it('渡した秘密値をリテラル一致で全て *** にする', () => {
      const masked = maskLiterals('token=abc and again abc / user U123', 'abc', 'U123');

      assert.strictEqual(masked, 'token=*** and again *** / user ***');
    });

    it('正規表現の特殊文字を含む秘密値でも例外にならずマスクする', () => {
      const secret = 'a+b*c[d](e)?';
      const masked = maskLiterals(`failed with ${secret}!`, secret);

      assert.strictEqual(masked, 'failed with ***!');
    });

    it('未設定(undefined/空文字)の秘密値は無視し、パターンマスクは通す', () => {
      const masked = maskLiterals('password=hunter2 ok', undefined, '');

      assert.strictEqual(masked, 'password=*** ok');
    });

    it('文字列以外の入力も文字列化して処理する', () => {
      assert.strictEqual(maskLiterals(new Error('boom secret').message, 'secret'), 'boom ***');
    });
  });

  describe('Turso設定', () => {
    /** 必須環境変数をすべてセットする(このファイルの他テストと同じ方式) */
    function setAllRequired() {
      process.env.SMILEZEMI_USERNAME = 'testuser';
      process.env.SMILEZEMI_PASSWORD = 'testpass';
      process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test_token';
      process.env.LINE_USER_ID = 'U1234567890';
      process.env.TURSO_DATABASE_URL = 'libsql://test-db.turso.io';
      process.env.TURSO_AUTH_TOKEN = 'test-auth-token';
    }

    it('TURSO_DATABASE_URL が未設定なら loadConfig が例外を投げる', () => {
      setAllRequired();
      delete process.env.TURSO_DATABASE_URL;

      assert.throws(() => loadConfig(), /TURSO_DATABASE_URL/);
    });

    it('TURSO_AUTH_TOKEN が未設定なら loadConfig が例外を投げる', () => {
      setAllRequired();
      delete process.env.TURSO_AUTH_TOKEN;

      assert.throws(() => loadConfig(), /TURSO_AUTH_TOKEN/);
    });

    it('loadConfig の戻り値に Turso の設定が含まれる', () => {
      setAllRequired();

      const result = loadConfig();

      assert.strictEqual(result.TURSO_DATABASE_URL, 'libsql://test-db.turso.io');
      assert.strictEqual(result.TURSO_AUTH_TOKEN, 'test-auth-token');
    });

    it('validateSecrets が Turso の2つを必須として扱う', () => {
      const result = validateSecrets({
        SMILEZEMI_USERNAME: 'u',
        SMILEZEMI_PASSWORD: 'p',
        LINE_CHANNEL_ACCESS_TOKEN: 't',
        LINE_USER_ID: 'g'
      });

      assert.strictEqual(result.valid, false);
      assert.ok(result.missing.includes('TURSO_DATABASE_URL'));
      assert.ok(result.missing.includes('TURSO_AUTH_TOKEN'));
    });

    it('maskLiterals が TURSO_AUTH_TOKEN の値を伏せる', () => {
      const masked = maskLiterals('auth eyJhbGciOi for libsql://x.turso.io', 'eyJhbGciOi');

      assert.strictEqual(masked, 'auth *** for libsql://x.turso.io', 'URLは秘密ではないので伏せない');
    });
  });
});
