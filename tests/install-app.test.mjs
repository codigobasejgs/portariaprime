// Detecção de aparelho para o botão "Instalar aplicativo": Android mostra o botão do sistema; iPhone/iPad, o passo a passo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPlatform, inAppBrowser } from '../src/components/InstallApp.tsx';

test('detectPlatform', () => {
  assert.equal(detectPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1', 5, 'iPhone'), 'ios');
  assert.equal(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15', 5, 'MacIntel'), 'ios', 'iPadOS se apresenta como Mac com toque');
  assert.equal(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15', 0, 'MacIntel'), 'other', 'Mac de mesa não é iPhone');
  assert.equal(detectPlatform('Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36', 5, 'Linux armv8l'), 'android');
  assert.equal(detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0', 0, 'Win32'), 'other');
});

test('inAppBrowser: WhatsApp e Instagram não instalam', () => {
  assert.equal(inAppBrowser('Mozilla/5.0 (Linux; Android 14) WhatsApp/2.24'), true);
  assert.equal(inAppBrowser('Mozilla/5.0 (iPhone) Instagram 300.0'), true);
  assert.equal(inAppBrowser('Mozilla/5.0 (Linux; Android 14) Chrome/131.0 Mobile Safari/537.36'), false);
});
