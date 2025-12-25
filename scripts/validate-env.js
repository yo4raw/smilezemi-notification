#!/usr/bin/env node
/**
 * 環境変数検証スクリプト
 *
 * 目的:
 * - 必要な環境変数がすべて設定されているか確認
 * - .envファイルの存在確認
 * - 環境変数の値の妥当性チェック
 */

const fs = require('fs');
const path = require('path');

// 必須環境変数のリスト
const REQUIRED_ENV_VARS = [
  'SMILEZEMI_USERNAME',
  'SMILEZEMI_PASSWORD',
  'LINE_CHANNEL_ACCESS_TOKEN',
  'LINE_USER_ID'
];

// 環境変数の妥当性チェック
const VALIDATION_RULES = {
  SMILEZEMI_USERNAME: {
    pattern: /.+@.+\..+/,
    description: 'メールアドレス形式である必要があります'
  },
  SMILEZEMI_PASSWORD: {
    minLength: 6,
    description: '6文字以上である必要があります'
  },
  LINE_CHANNEL_ACCESS_TOKEN: {
    minLength: 100,
    description: '100文字以上のトークンである必要があります'
  },
  LINE_USER_ID: {
    pattern: /^U[0-9a-f]{32}$/,
    description: 'U + 32文字の16進数形式である必要があります'
  }
};

function main() {
  console.log('🔍 環境変数検証を開始します...\n');

  let hasError = false;
  const errors = [];
  const warnings = [];

  // .envファイルの存在確認
  const envFilePath = path.join(__dirname, '../.env');
  if (fs.existsSync(envFilePath)) {
    console.log('✅ .envファイルが見つかりました');

    // .envファイルを読み込む
    require('dotenv').config({ path: envFilePath });
  } else {
    console.log('⚠️  .envファイルが見つかりません（GitHub Actions環境では正常）');
    warnings.push('.envファイルが見つかりません');
  }

  console.log('\n📋 必須環境変数のチェック:\n');

  // 各環境変数をチェック
  REQUIRED_ENV_VARS.forEach(varName => {
    const value = process.env[varName];

    if (!value) {
      console.log(`❌ ${varName}: 未設定`);
      errors.push(`${varName}が設定されていません`);
      hasError = true;
      return;
    }

    // 値の妥当性チェック
    const rules = VALIDATION_RULES[varName];
    let isValid = true;
    let validationMessage = '';

    if (rules) {
      if (rules.pattern && !rules.pattern.test(value)) {
        isValid = false;
        validationMessage = rules.description;
      }

      if (rules.minLength && value.length < rules.minLength) {
        isValid = false;
        validationMessage = rules.description;
      }
    }

    if (isValid) {
      // 値の一部のみ表示（マスキング）
      const maskedValue = value.length > 10
        ? `${value.substring(0, 5)}...${value.substring(value.length - 3)}`
        : '***';
      console.log(`✅ ${varName}: ${maskedValue}`);
    } else {
      console.log(`❌ ${varName}: 設定されていますが形式が無効です`);
      console.log(`   ${validationMessage}`);
      errors.push(`${varName}の形式が無効です: ${validationMessage}`);
      hasError = true;
    }
  });

  // 結果サマリー
  console.log('\n' + '='.repeat(60));

  if (hasError) {
    console.log('\n❌ 検証失敗\n');
    console.log('エラー:');
    errors.forEach(err => console.log(`  - ${err}`));

    if (warnings.length > 0) {
      console.log('\n警告:');
      warnings.forEach(warn => console.log(`  - ${warn}`));
    }

    console.log('\n対処方法:');
    console.log('  1. .envファイルを作成してください:');
    console.log('     cp .env.example .env');
    console.log('  2. .envファイルに正しい値を設定してください');
    console.log('  3. 再度このスクリプトを実行して確認してください\n');

    process.exit(1);
  } else {
    console.log('\n✅ すべての環境変数が正しく設定されています！\n');

    if (warnings.length > 0) {
      console.log('警告:');
      warnings.forEach(warn => console.log(`  - ${warn}`));
      console.log('');
    }

    process.exit(0);
  }
}

// dotenvが利用可能か確認
try {
  require('dotenv');
  main();
} catch (error) {
  console.log('⚠️  dotenvパッケージがインストールされていません');
  console.log('環境変数は既に設定されているものとして検証を続行します\n');
  main();
}
