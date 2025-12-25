/**
 * 環境変数管理とシークレット処理のテスト
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 9.1, 9.2, 9.3, 9.4
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { loadConfig, validateSecrets, maskSensitiveData } = require('../src/config');

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

      const config = loadConfig();

      assert.strictEqual(config.smilezemi.username, 'testuser');
      assert.strictEqual(config.smilezemi.password, 'testpass');
      assert.strictEqual(config.line.channelAccessToken, 'test_token');
      assert.strictEqual(config.line.userId, 'U1234567890');
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
  });

  describe('validateSecrets', () => {
    it('全てのシークレットが存在する場合、trueを返す', () => {
      const secrets = {
        SMILEZEMI_USERNAME: 'testuser',
        SMILEZEMI_PASSWORD: 'testpass',
        LINE_CHANNEL_ACCESS_TOKEN: 'token',
        LINE_USER_ID: 'userid'
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
    it('パスワードをマスキングする', () => {
      const data = { password: 'secretpassword123' };
      const masked = maskSensitiveData(data);

      assert.strictEqual(masked.password, '***');
    });

    it('トークンをマスキングする', () => {
      const data = { token: 'mySecretToken456' };
      const masked = maskSensitiveData(data);

      assert.strictEqual(masked.token, '***');
    });

    it('ユーザー名はマスキングしない', () => {
      const data = { username: 'testuser' };
      const masked = maskSensitiveData(data);

      assert.strictEqual(masked.username, 'testuser');
    });

    it('複数のフィールドを適切にマスキングする', () => {
      const data = {
        username: 'testuser',
        password: 'pass123',
        channelAccessToken: 'token456',
        userId: 'U123'
      };
      const masked = maskSensitiveData(data);

      assert.strictEqual(masked.username, 'testuser');
      assert.strictEqual(masked.password, '***');
      assert.strictEqual(masked.channelAccessToken, '***');
      assert.strictEqual(masked.userId, 'U123');
    });

    it('ログメッセージ内の認証情報をマスキングする', () => {
      const message = 'Logging in with password=secretpass123 and token=mytoken456';
      const masked = maskSensitiveData(message);

      assert.ok(!masked.includes('secretpass123'));
      assert.ok(!masked.includes('mytoken456'));
      assert.ok(masked.includes('***'));
    });
  });
});
