#!/usr/bin/env node
/**
 * .envファイルを読み込んで環境変数に設定し、指定されたスクリプトを実行
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// .envファイルを読み込む
const envPath = path.join(__dirname, '../.env');

if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');

  // 各行をパースして環境変数に設定
  envContent.split('\n').forEach(line => {
    line = line.trim();

    // 空行やコメント行をスキップ
    if (!line || line.startsWith('#')) {
      return;
    }

    // KEY=VALUE形式をパース
    const match = line.match(/^([^=]+)=(.*)$/);
    if (match) {
      const key = match[1].trim();
      let value = match[2].trim();

      // クォートを削除（シングルまたはダブル）
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      // 環境変数に設定
      process.env[key] = value;
      console.log(`  ${key}=${value.substring(0, 5)}... (${value.length}文字)`);
    }
  });

  console.log('✅ .envファイルを読み込みました');
} else {
  console.error('❌ .envファイルが見つかりません');
  process.exit(1);
}

// 引数で指定されたスクリプトを実行
const scriptPath = process.argv[2];

if (!scriptPath) {
  console.error('❌ 実行するスクリプトを指定してください');
  console.error('使用方法: node load-env-and-run.js <script-path>');
  process.exit(1);
}

// スクリプトを実行
console.log(`🚀 スクリプトを実行: ${scriptPath}\n`);
require(path.resolve(scriptPath));
