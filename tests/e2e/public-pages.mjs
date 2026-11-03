// Páginas públicas novas no navegador real (stack local, sem login, sem envios):
// landing (seis momentos, demonstração por perfil, proposta, planos do banco, sem alegações proibidas),
// tutoriais, documentos legais em minuta, /validar e /proposta com token inválido, indexação e
// matriz de larguras 320–1920 sem rolagem horizontal.
//
// APP=http://127.0.0.1:3017 node tests/e2e/public-pages.mjs
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const APP = process.env.APP || 'http://127.0.0.1:3017';
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(APP).hostname));
const step = (s) => console.log(`- ${s}`);
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const robots = async () => page.evaluate(() => document.querySelector('meta[name="robots"]')?.getAttribute('content') || null);

  step('landing: hero, seis momentos interativos, demonstração por perfil, proposta e planos');
  await page.goto(`${APP}/`);
  await page.getByRole('heading', { level: 1, name: 'Cada encomenda. Tudo sob controle.' }).waitFor();
  assert.equal(await robots(), null, 'landing indexável');
  const tabs = page.getByRole('tablist', { name: 'Momentos da encomenda' }).getByRole('tab');
  assert.equal(await tabs.count(), 6);
  await tabs.nth(4).click();
  assert.equal(await tabs.nth(4).getAttribute('aria-selected'), 'true');
  await page.getByText('Efeito:').waitFor();
  await page.getByRole('tablist', { name: 'Perfil' }).getByRole('tab', { name: 'Morador', exact: true }).click();
  await page.getByRole('link', { name: /Tutorial completo para morador/ }).waitFor();
  await page.getByRole('heading', { name: 'Receba uma proposta competitiva' }).waitFor();
  await page.getByRole('heading', { name: 'Tenho um orçamento para comparar' }).waitFor();
  await page.locator('#planos').getByText('Profissional', { exact: true }).first().waitFor();
  // "Modo Portaria Exclusiva" é o nome do produto (aprovado, em produção desde 29/10/2026); a regra
  // continua barrando "exclusividade"/"exclusivo do mercado" e afins.
  const text = (await page.locator('body').innerText()).toLowerCase().replace(/(modo )?portaria exclusiva/g, '');
  for (const banned of ['menor preço', 'segurança total', 'ilimitad', 'exclusiv', '99,9', '24h', 'app store e', 'cobrimos qualquer', 'depoimento', 'clientes satisfeitos', '59.760.458']) {
    assert.ok(!text.includes(banned), `alegação proibida na landing: ${banned}`);
  }

  step('tutoriais públicos indexáveis, busca e progresso');
  await page.getByRole('link', { name: 'Tutoriais', exact: true }).first().click();
  await page.waitForURL(/\/tutoriais$/);
  assert.equal(await robots(), null, 'tutoriais indexáveis');
  await page.getByLabel('Buscar tarefa').fill('aprovar morador');
  await page.getByRole('link', { name: /Aprovar moradores/ }).click();
  await page.waitForURL(/\/tutoriais\/sindico#aprovar-moradores/);
  await page.locator('#aprovar-moradores').getByLabel('Marcar como concluído').check();
  await page.getByText(/Progresso neste navegador: 1 de/).waitFor();

  step('documentos legais: minuta não vigente, sem dados inventados da contratada');
  for (const [path, title] of [['/contrato', /contrato/i], ['/termos', /termos/i], ['/privacidade', /privacidade/i]]) {
    await page.goto(`${APP}${path}`);
    await page.getByRole('heading', { level: 1, name: title }).waitFor();
    const body = await page.locator('body').innerText();
    assert.match(body, /não vigente|minuta/i, `${path} sem aviso de minuta`);
    assert.doesNotMatch(body, /\{\{[A-Z_]+\}\}|59\.760\.458/, `${path} com placeholder ou CNPJ não confirmado`);
  }

  step('/validar e /proposta: fora do índice, resposta mínima para código inválido');
  await page.goto(`${APP}/validar`);
  assert.equal(await robots(), 'noindex,nofollow');
  const code = page.getByRole('textbox').first();
  await code.fill('0000-0000-0000-0000-0000');
  await page.getByRole('button', { name: /Verificar|Validar|Conferir/ }).click();
  await page.getByText(/não (foi )?encontrad|inválid|não confere/i).first().waitFor();
  await page.goto(`${APP}/proposta#token-inexistente`);
  assert.equal(await robots(), 'noindex,nofollow');
  await page.getByText(/não encontrada|inválid|vencid|indisponível/i).first().waitFor();

  step('/planos: ciclos com desconto, contrato preenchido ao vivo e pedido com preço do servidor');
  await page.goto(`${APP}/planos?plano=profissional&ciclo=yearly`);
  assert.equal(await robots(), null, '/planos indexável');
  await page.getByRole('radio', { name: /Anual.*−15%/ }).waitFor();
  await page.getByRole('radio', { name: /Trimestral.*−5%/ }).waitFor();
  await page.getByText(/economia de R\$/).first().waitFor();
  await page.getByLabel('Nome do condomínio').fill('Residencial Teste E2E');
  await page.getByLabel('Nome completo do representante').fill('Pessoa Teste E2E');
  await page.getByLabel('E-mail').fill(`planos-${Date.now()}@example.invalid`);
  const box = page.getByLabel('Contrato preenchido');
  await box.getByText(/Residencial Teste E2E, representado por Pessoa Teste E2E/).waitFor();
  await box.getByText(/Plano escolhido nesta contratação:/).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Enviar pedido de contratação' }).isDisabled(), true, 'sem concordância não envia');
  await page.getByText(/Li o contrato acima e concordo/).click();
  await page.getByRole('button', { name: 'Enviar pedido de contratação' }).click();
  await page.getByText(/Pedido PC-\d{8}-[0-9A-F]{6} recebido/).waitFor();
  await page.getByRole('button', { name: 'Ativar o mês grátis com este plano' }).waitFor();

  step('rota privada sem sessão exige login (contratar, org)');
  for (const path of ['/contratar', '/org']) {
    await page.goto(`${APP}${path}`);
    await page.waitForURL(/\/entrar\?next=/);
  }

  step('larguras 320–1920 sem rolagem horizontal');
  for (const [w, h] of [[320, 640], [360, 740], [390, 844], [430, 932], [768, 1024], [820, 1180], [1024, 768], [1280, 800], [1440, 900], [1920, 1080], [844, 390]]) {
    await page.setViewportSize({ width: w, height: h });
    for (const path of ['/', '/planos', '/tutoriais', '/tutoriais/portaria', '/contrato', '/validar']) {
      await page.goto(`${APP}${path}`);
      await page.locator('h1').first().waitFor();
      await page.waitForTimeout(100);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      assert.ok(over <= 0, `rolagem horizontal em ${path} @${w}x${h} (${over}px)`);
    }
    if ([390, 1280].includes(w)) {
      await page.goto(`${APP}/`); await page.locator('h1').first().waitFor();
      await page.screenshot({ path: `tests/evidence/landing-${w}.png`, fullPage: true });
    }
  }
  assert.deepEqual(errors, [], 'sem erros de página');
  console.log('OK public-pages');
} finally {
  await browser.close();
}
