package br.com.portariaprime.kiosk

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.ActivityManager
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.provider.Settings
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.*
import android.widget.*
import br.com.portariaprime.kiosk.core.NavigationGuard
import br.com.portariaprime.kiosk.core.RecoveryCodes
import org.json.JSONObject
import java.io.File
import java.net.URL
import java.util.concurrent.Executors

/**
 * Tela única do quiosque (também é o launcher HOME):
 *  - não inscrito: tela de inscrição (código de uso único);
 *  - Single-App: WebView endurecida com a portaria do condomínio vinculado;
 *  - Multi-App: barra com atalhos só dos apps aprovados e instalados;
 *  - manutenção: aviso com contagem regressiva + acesso às Configurações; volta sozinho no prazo.
 * Sem bridge JavaScript: a página web não tem acesso ao DPC, a comandos nem a segredos.
 */
class KioskActivity : Activity() {
    private lateinit var agent: Agent
    private lateinit var root: FrameLayout
    private var web: WebView? = null
    private var guard: NavigationGuard? = null
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var pendingPermission: PermissionRequest? = null
    private val ui = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private val tick = object : Runnable { override fun run() { render(); ui.postDelayed(this, 30_000) } }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        agent = Agent.get(this)
        root = FrameLayout(this).apply { setBackgroundColor(Color.parseColor("#101F30")) }
        if (BuildConfig.LAB_BUILD) setContentView(LinearLayout(this).apply {
            // Faixa fixa: a variante de laboratório (testOnly, ADB sempre ligado) nunca pode passar por versão de cliente.
            orientation = LinearLayout.VERTICAL
            addView(TextView(context).apply { text = "LABORATÓRIO · versão de teste · não usar em cliente"; setTextColor(Color.WHITE); textSize = 13f
                gravity = Gravity.CENTER; setPadding(8, 6, 8, 6); setBackgroundColor(Color.parseColor("#B91C1C")) })
            addView(root, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        }) else setContentView(root)
        // Android 15+ (targetSdk 35) desenha por baixo das barras e ignora adjustResize: recua o conteúdo pela barra de
        // navegação, status, recorte da câmera e teclado de cada aparelho. Abaixo do 15 o sistema já faz isso sozinho.
        // Fundo escuro atrás das barras: ícones claros (voltar, relógio) para continuarem visíveis.
        if (Build.VERSION.SDK_INT >= 35) window.insetsController?.setSystemBarsAppearance(0,
            WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS)
        if (Build.VERSION.SDK_INT >= 35) findViewById<View>(android.R.id.content).apply { setBackgroundColor(Color.parseColor("#101F30")) }
            .setOnApplyWindowInsetsListener { v, insets ->
                val i = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout() or WindowInsets.Type.ime())
                v.setPadding(i.left, i.top, i.right, i.bottom)
                insets
            }
        // Token do QR (provisionamento) é consumido aqui se ainda não inscrito.
        getSharedPreferences("kiosk", MODE_PRIVATE).getString("pending_token", null)?.let { t -> if (agent.store.deviceId == null) enroll(t) }
        agent.listener = { ui.post { render() } }
        agent.applyLocal()
        agent.syncAsync()
    }

    override fun onResume() {
        super.onResume()
        agent.applyLocal()
        enterLockTask()
        render()
        ui.postDelayed(tick, 30_000)
    }

    override fun onPause() { ui.removeCallbacks(tick); super.onPause() }

    private fun enterLockTask() {
        val am = getSystemService(ActivityManager::class.java)
        if (agent.enforcer.isDeviceOwner && !agent.maintenanceActive() && am.lockTaskModeState == ActivityManager.LOCK_TASK_MODE_NONE) {
            try { startLockTask() } catch (_: Exception) {}
        } else if (agent.maintenanceActive() && am.lockTaskModeState != ActivityManager.LOCK_TASK_MODE_NONE) {
            try { stopLockTask() } catch (_: Exception) {}
        }
    }

    // Voltar navega no histórico da WebView; nunca sai do quiosque.
    @Deprecated("API antiga, mantida para Android 8–12")
    override fun onBackPressed() { web?.takeIf { it.canGoBack() }?.goBack() }

    private var mode = ""
    private fun render() {
        val s = agent.store
        val p = s.policy()
        requestedOrientation = when (p.orientation) { "portrait" -> ActivityInfo.SCREEN_ORIENTATION_PORTRAIT; "landscape" -> ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
            else -> ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED }
        if (p.keepScreenOn) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val next = when {
            s.released && !agent.enforcer.isDeviceOwner -> "released"
            s.deviceId == null || s.revoked -> "enroll"   // revogado: reinscrição com código novo, sem liberar o aparelho
            agent.maintenanceActive() -> "maintenance"
            else -> "web"
        }
        enterLockTask()
        if (next == mode && next == "web") { updateBanner(); return }
        mode = next
        root.removeAllViews()
        when (next) {
            "enroll" -> root.addView(enrollView())
            "maintenance" -> root.addView(maintenanceView())
            "released" -> root.addView(releasedView())
            else -> root.addView(webLayout())
        }
    }

    // ---- Inscrição -------------------------------------------------------------------------------

    private fun enroll(token: String) {
        Toast.makeText(this, "Inscrevendo aparelho…", Toast.LENGTH_SHORT).show()
        agent.enrollAsync(token) { err -> ui.post { if (err != null) AlertDialog.Builder(this).setMessage(err).setPositiveButton("OK", null).show(); mode = ""; render() } }
    }

    private fun enrollView(): View = column(padding = 48).apply {
        addView(title("Portaria Prime Kiosk"))
        if (agent.store.revoked) addView(text("A credencial deste aparelho foi revogada no painel. O quiosque continua protegido com a última política. Para voltar a operar, o síndico gera um novo código de inscrição."))
        addView(text(if (agent.enforcer.isDeviceOwner) "Aparelho provisionado. Digite o código de inscrição gerado em Configurações → Dispositivos e quiosque (uso único, vale 1 hora)."
            else "Este aplicativo não é o proprietário do aparelho (Device Owner). Sem isso não há quiosque protegido: provisione pelo QR na configuração inicial do Android. Fullscreen ou fixação de tela não equivalem a gerenciamento."))
        val input = EditText(context).apply { hint = "Código de inscrição"; inputType = CODE_INPUT; setTextColor(Color.WHITE); setHintTextColor(Color.LTGRAY) }
        addView(input)
        addView(button("Inscrever") { enroll(input.text.toString().uppercase().filter { it.isLetterOrDigit() }) })
        addView(text("Agente ${BuildConfig.VERSION_NAME} · Android ${android.os.Build.VERSION.RELEASE}"))
    }

    /** Depois da desativação pelo painel: aparelho comum de novo; o app pode ser desinstalado. */
    private fun releasedView(): View = column(padding = 48).apply {
        addView(title("Gerenciamento retirado"))
        addView(text("O síndico desativou o gerenciamento deste aparelho. O modo quiosque e as restrições do Portaria Prime foram removidos; nenhum dado do aparelho foi apagado."))
        addView(text("Para remover este aplicativo: Configurações → Apps → Portaria Prime Kiosk → Desinstalar. Se o Android perguntar qual tela inicial usar, escolha a do fabricante."))
        addView(button("Abrir detalhes do app") {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        })
        addView(text("Agente ${BuildConfig.VERSION_NAME} · Android ${android.os.Build.VERSION.RELEASE}"))
    }

    // ---- Operação (WebView + barra) --------------------------------------------------------------

    private var banner: TextView? = null
    private var appsBar: LinearLayout? = null

    private fun webLayout(): View {
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        banner = TextView(this).apply { setPadding(24, 8, 24, 8); setTextColor(Color.WHITE); textSize = 13f; visibility = View.GONE; setBackgroundColor(Color.parseColor("#B45309")) }
        col.addView(banner)
        appsBar = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; setPadding(8, 4, 8, 4) }
        col.addView(HorizontalScrollView(this).apply { addView(appsBar) })
        col.addView(webView(), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        updateBanner()
        return col
    }

    private fun updateBanner() {
        val s = agent.store
        val offlineMin = if (s.lastSyncOkWall == 0L) null else (System.currentTimeMillis() - s.lastSyncOkWall) / 60_000
        val msg = when {
            !agent.enforcer.isDeviceOwner -> "Não gerenciado: quiosque sem proteção do Android."
            s.revoked -> "Credencial do aparelho revogada. A última política continua aplicada; procure o síndico."
            s.failures > 0 && (offlineMin ?: 0) >= 5 -> "Sem contato com o servidor há ${offlineMin} min. A portaria só confirma entregas com conexão."
            else -> null
        }
        banner?.text = msg; banner?.visibility = if (msg == null) View.GONE else View.VISIBLE
        val bar = appsBar ?: return
        bar.removeAllViews()
        val p = s.policy()
        if (!p.singleApp) {
            val meta = s.appsMeta
            for (i in 0 until meta.length()) {
                val m = meta.getJSONObject(i)
                val pkg = m.getString("package_name")
                if (pkg !in p.apps) continue
                val vc = agent.enforcer.versionCode(pkg)
                val state = when { vc == null -> "ausente"; vc < m.optLong("min_version_code") -> "versão incompatível"; else -> null }
                bar.addView(button(if (state == null) m.getString("label") else "${m.getString("label")} ($state)") {
                    if (state == null) packageManager.getLaunchIntentForPackage(pkg)?.let { startActivity(it) }
                    else Toast.makeText(this, "App $state. Peça ao síndico.", Toast.LENGTH_LONG).show()
                }.apply { isEnabled = state == null })
            }
        }
        bar.addView(button("Manutenção") { askRecovery() })
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun webView(): WebView {
        web?.let { (it.parent as? ViewGroup)?.removeView(it); return it }
        val lab = BuildConfig.LAB_LOOPBACK
        val origins = setOfNotNull(NavigationGuard.origin(BuildConfig.SUPABASE_ORIGIN, lab))
        val g = NavigationGuard(BuildConfig.APP_ORIGIN, origins, lab, setOf(BuildConfig.LEGACY_APP_ORIGIN)).also { guard = it }
        val slug = agent.store.tenantSlug
        // DevTools da WebView só no build de laboratório (testes automatizados); nunca em release.
        WebView.setWebContentsDebuggingEnabled(BuildConfig.LAB_LOOPBACK)
        val w = WebView(this)
        with(w.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            @Suppress("DEPRECATION") allowFileAccessFromFileURLs = false
            @Suppress("DEPRECATION") allowUniversalAccessFromFileURLs = false
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            mediaPlaybackRequiresUserGesture = true
            setGeolocationEnabled(false)
            safeBrowsingEnabled = true
            userAgentString = "$userAgentString PortariaPrimeKiosk/${BuildConfig.VERSION_NAME}"
        }
        CookieManager.getInstance().setAcceptThirdPartyCookies(w, false)
        w.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url.toString()
                return when (g.navigation(url, slug)) {
                    NavigationGuard.Decision.ALLOW -> false
                    NavigationGuard.Decision.PDF_VIEWER -> { openPdf(url); true }
                    NavigationGuard.Decision.BLOCK -> {
                        Toast.makeText(this@KioskActivity, "Link externo bloqueado no quiosque.", Toast.LENGTH_SHORT).show()
                        // Navegação do quadro principal cancelada pode deixar a página descarregada (tela branca):
                        // se o app web não estiver montado, volta ao início do condomínio.
                        if (request.isForMainFrame) ui.postDelayed({
                            view.evaluateJavascript("(document.getElementById('root')||{}).childElementCount||0") { n ->
                                if (n == "0" || n == "null") view.loadUrl(if (slug != null) startUrl(g, slug) else BuildConfig.APP_ORIGIN + "/entrar")
                            }
                        }, 1500)
                        true
                    }
                }
            }
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                if (g.resource(request.url.toString())) null else WebResourceResponse("text/plain", "utf-8", 403, "Bloqueado", emptyMap(), null)
            // SPA: pushState/replaceState não passam por shouldOverrideUrlLoading. Rota fora da lista volta ao início.
            override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
                // Páginas internas (tela offline em about:blank/data:, erro do Chromium) não são navegação do usuário.
                if (!url.startsWith("http")) return
                if (g.navigation(url, slug) != NavigationGuard.Decision.ALLOW) {
                    val now = SystemClock.elapsedRealtime()
                    if (now - lastBlockedEvent > 60_000) {   // sem inundar a auditoria
                        lastBlockedEvent = now
                        agent.event("policy.failed", JSONObject().put("detail", "rota bloqueada: ${Uri.parse(url).path?.take(60)}"))
                    }
                    Toast.makeText(this@KioskActivity, "Área indisponível no quiosque.", Toast.LENGTH_SHORT).show()
                    view.loadUrl(if (slug != null) startUrl(g, slug) else BuildConfig.APP_ORIGIN + "/entrar")
                }
            }
            // Erro SSL nunca é ignorado.
            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: android.net.http.SslError) { handler.cancel(); showOffline() }
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) { if (request.isForMainFrame) showOffline() }
            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                // WebView travou/caiu: recria sem sair do quiosque e sem loop (só a tela, não o app).
                agent.event("agent.restart", JSONObject().put("detail", "webview"))
                (view.parent as? ViewGroup)?.removeView(view); view.destroy(); web = null; mode = ""; ui.postDelayed({ render() }, 1500); return true
            }
        }
        w.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                val camOnly = request.resources.all { it == PermissionRequest.RESOURCE_VIDEO_CAPTURE }
                if (!camOnly || !g.mayUseCamera(request.origin.toString())) { request.deny(); return }
                if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) request.grant(request.resources)
                else { pendingPermission = request; requestPermissions(arrayOf(Manifest.permission.CAMERA), 2) }
            }
            override fun onShowFileChooser(view: WebView, cb: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                // Só imagens (foto da etiqueta/item) e CSV de importação; o seletor do sistema não abre outros apps em Lock Task.
                fileCallback?.onReceiveValue(null); fileCallback = cb
                return try { startActivityForResult(params.createIntent().addCategory(Intent.CATEGORY_OPENABLE), 3); true } catch (_: Exception) { fileCallback = null; false }
            }
            override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: android.os.Message) = false
            override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) = callback.invoke(origin, false, false)
        }
        w.setDownloadListener { url, _, _, mime, _ ->
            if (mime == "application/pdf" || url.lowercase().contains(".pdf")) {
                if (g.navigation(url, slug) == NavigationGuard.Decision.PDF_VIEWER || g.resource(url)) openPdf(url)
            } else Toast.makeText(this, "Download bloqueado no quiosque.", Toast.LENGTH_SHORT).show()
        }
        w.loadUrl(if (slug != null) startUrl(g, slug) else BuildConfig.APP_ORIGIN + "/entrar")
        web = w
        return w
    }

    private fun startUrl(g: NavigationGuard, slug: String) =
        g.startUrl(slug, agent.store.policy().startPath) + (agent.store.shiftNonce?.let { "#ppk=$it" } ?: "")

    private var lastBlockedEvent = 0L
    private var offlineRetry = false
    private fun showOffline() {
        if (offlineRetry) return   // uma nova tentativa por vez (sem laço)
        offlineRetry = true
        web?.loadDataWithBaseURL(null, "<html><body style='font-family:sans-serif;padding:24px;background:#101F30;color:#fff'>" +
            "<h2>Sem conexão com o Portaria Prime</h2><p>O quiosque continua protegido. Recebimentos e entregas só são confirmados com conexão — nenhum comprovante é gerado offline.</p>" +
            "<p>Tentando de novo automaticamente…</p></body></html>", "text/html", "utf-8", null)
        ui.postDelayed({ offlineRetry = false; val s = agent.store.tenantSlug; if (s != null && mode == "web") web?.loadUrl(startUrl(guard!!, s)) }, 20_000)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        val r = pendingPermission ?: return
        pendingPermission = null
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) r.grant(r.resources) else r.deny()
    }

    @Deprecated("startActivityForResult é suficiente sem AndroidX")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == 3) { fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data)); fileCallback = null }
    }

    /** PDF assinado (URL temporária do Storage) renderizado internamente: sem navegador nem app externo. */
    private fun openPdf(url: String) {
        io.execute {
            try {
                val f = File(cacheDir, "comprovante.pdf")
                val c = URL(url).openConnection() as java.net.HttpURLConnection
                if (c !is javax.net.ssl.HttpsURLConnection && !BuildConfig.LAB_LOOPBACK) throw IllegalStateException("somente HTTPS")
                c.connectTimeout = 15_000; c.readTimeout = 30_000
                c.inputStream.use { inp -> f.outputStream().use { out -> inp.copyTo(out, 64 * 1024) } }
                if (f.length() > 20L * 1024 * 1024) throw IllegalStateException("PDF grande demais")
                val pages = mutableListOf<android.graphics.Bitmap>()
                PdfRenderer(ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY)).use { r ->
                    for (i in 0 until minOf(r.pageCount, 10)) r.openPage(i).use { pg ->
                        val scale = resources.displayMetrics.widthPixels.toFloat() / pg.width
                        val bmp = android.graphics.Bitmap.createBitmap((pg.width * scale).toInt(), (pg.height * scale).toInt(), android.graphics.Bitmap.Config.ARGB_8888)
                        bmp.eraseColor(Color.WHITE); pg.render(bmp, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY); pages += bmp
                    }
                }
                f.delete()
                ui.post {
                    val list = column(padding = 8).apply { pages.forEach { addView(ImageView(context).apply { setImageBitmap(it); adjustViewBounds = true }) } }
                    AlertDialog.Builder(this).setView(ScrollView(this).apply { addView(list) }).setPositiveButton("Fechar", null).show()
                }
            } catch (_: Exception) { ui.post { Toast.makeText(this, "Não foi possível abrir o PDF.", Toast.LENGTH_LONG).show() } }
        }
    }

    // ---- Manutenção ------------------------------------------------------------------------------

    private fun maintenanceView(): View = column(padding = 48).apply {
        val m = agent.store.maintenance()
        addView(title("Em manutenção"))
        addView(text("Quiosque suspenso temporariamente para ajustes autorizados; o aparelho continua gerenciado. Volta sozinho ao Portaria Prime em ${agent.maintenanceRemainingMs() / 60_000 + 1} min ou ao reiniciar."))
        addView(text("Restauração de fábrica, novos usuários/contas e modo de segurança continuam bloqueados. Retirar o gerenciamento é outro procedimento, feito pelo síndico no painel."))
        addView(text("Escopo: ${when (m?.scope) { "wifi" -> "Wi-Fi"; "apps" -> "apps"; else -> "configurações" }}"))
        addView(button("Abrir configurações do Android") {
            startActivity(Intent(if (m?.scope == "wifi") Settings.ACTION_WIFI_SETTINGS else Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        })
        addView(button("Encerrar manutenção agora") { agent.endMaintenanceLocal("manual"); mode = ""; render() })
    }

    /** Recuperação offline: código descartável do síndico, validado localmente (hash), com limite de tentativas. */
    private fun askRecovery() {
        val s = agent.store
        val input = EditText(this).apply { hint = "Código de recuperação"; inputType = CODE_INPUT }
        AlertDialog.Builder(this).setTitle("Manutenção do síndico")
            .setMessage("Online: o síndico abre a manutenção pelo painel. Sem internet: digite um código de recuperação deste aparelho (uso único).")
            .setView(input).setNegativeButton("Cancelar", null)
            .setPositiveButton("Validar") { _, _ ->
                io.execute {
                    val att = s.attempts().apply { onBoot(s.bootCount(), SystemClock.elapsedRealtime()) }
                    val r = RecoveryCodes(s.recoveryCodes()).verify(input.text.toString(), att, SystemClock.elapsedRealtime())
                    s.saveAttempts(att)
                    ui.post {
                        when (r) {
                            is RecoveryCodes.Result.Ok -> {
                                s.markRecoveryUsed(r.idx)
                                val minutes = minOf(15, s.policy().maintenanceMaxMinutes)
                                agent.event("maintenance.offline_start", JSONObject().put("idx", r.idx).put("version", s.recoveryVersion()).put("minutes", minutes))
                                agent.startMaintenance(minutes, null, "settings"); mode = ""; render()
                            }
                            is RecoveryCodes.Result.Wrong -> { agent.event("recovery.failed", JSONObject()); Toast.makeText(this, "Código inválido.", Toast.LENGTH_LONG).show() }
                            is RecoveryCodes.Result.Locked -> { agent.event("recovery.locked", JSONObject()); Toast.makeText(this, "Muitas tentativas. Aguarde ${r.retryInMs / 60_000 + 1} min.", Toast.LENGTH_LONG).show() }
                            RecoveryCodes.Result.NoCodes -> Toast.makeText(this, "Sem códigos de recuperação neste aparelho. Peça ao síndico a manutenção pelo painel.", Toast.LENGTH_LONG).show()
                        }
                    }
                }
            }.show()
    }

    // ---- UI mínima ---------------------------------------------------------------------------------

    // Códigos (inscrição e recuperação): sem sugestões nem autocorreção. Achado no emulador: o teclado
    // reescrevia o código digitado e um código válido virava "inválido" (e contava tentativa).
    private val CODE_INPUT = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS or
        InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD

    private fun column(padding: Int) = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(padding, padding, padding, padding); gravity = Gravity.CENTER_HORIZONTAL }
    private fun title(s: String) = TextView(this).apply { text = s; textSize = 26f; setTextColor(Color.WHITE); setPadding(0, 0, 0, 24) }
    private fun text(s: String) = TextView(this).apply { text = s; textSize = 16f; setTextColor(Color.WHITE); setPadding(0, 8, 0, 8) }
    private fun button(s: String, on: () -> Unit) = Button(this).apply { text = s; isAllCaps = false; setOnClickListener { on() } }

    override fun onDestroy() { agent.listener = null; super.onDestroy() }
}
