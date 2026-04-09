<?php
/**
 * Plugin Name: ConsentHub Espanol
 * Description: Banner de cookies y centro de preferencias para sitios WordPress en espanol.
 * Version: 0.1.0
 * Author: ConsentHub
 */

if (!defined('ABSPATH')) {
    exit;
}

require_once plugin_dir_path(__FILE__) . 'includes/class-consenthub-admin.php';

class ConsentHubPlugin {
    public function __construct() {
        register_activation_hook(__FILE__, array(__CLASS__, 'on_activation'));

        add_action('admin_menu', array($this, 'register_admin_menu'));
        add_action('admin_init', array($this, 'register_settings'));
        add_action('admin_post_consenthub_wizard_step', array('ConsentHubAdmin', 'handle_wizard_step'));
        add_action('wp_enqueue_scripts', array($this, 'enqueue_assets'));
        add_action('wp_footer', array($this, 'render_banner'));
        add_action('wp_ajax_consenthub_track_event', array($this, 'handle_track_event'));
        add_action('wp_ajax_nopriv_consenthub_track_event', array($this, 'handle_track_event'));
    }

    public static function on_activation() {
        if (get_option('consenthub_site_id', '') === '') {
            update_option('consenthub_site_id', parse_url(home_url(), PHP_URL_HOST));
        }
        if (get_option('consenthub_country', '') === '') {
            update_option('consenthub_country', 'CL');
        }
        if (get_option('consenthub_banner_title', '') === '') {
            update_option('consenthub_banner_title', 'Tu privacidad importa');
        }
        if (get_option('consenthub_banner_text', '') === '') {
            update_option('consenthub_banner_text', 'Usamos cookies para mejorar tu experiencia. Puedes aceptar, rechazar o personalizar.');
        }
        if (get_option('consenthub_default_analytics', '') === '') {
            update_option('consenthub_default_analytics', '0');
        }
        if (get_option('consenthub_default_marketing', '') === '') {
            update_option('consenthub_default_marketing', '0');
        }
        if (get_option('consenthub_setup_complete', '') === '') {
            update_option('consenthub_setup_complete', '0');
        }
        if (get_option('consenthub_legal_disclaimer', '') === '') {
            update_option('consenthub_legal_disclaimer', 'ConsentHub facilita la implementacion tecnica de consentimiento, pero no constituye asesoria legal.');
        }
        if (get_option('consenthub_cookie_policy_template', '') === '') {
            update_option('consenthub_cookie_policy_template', 'Usamos cookies necesarias para el funcionamiento del sitio y, con tu consentimiento, cookies de analitica y marketing para mejorar la experiencia y medir resultados. Puedes cambiar tus preferencias en cualquier momento desde el banner de consentimiento.');
        }
        if (get_option('consenthub_privacy_policy_template', '') === '') {
            update_option('consenthub_privacy_policy_template', 'Tratamos datos personales para operar este sitio, responder solicitudes y mejorar nuestros servicios. Cuando corresponde, solicitamos consentimiento para analitica y marketing. Puedes ejercer tus derechos de acceso, rectificacion y eliminacion contactandonos mediante los canales publicados en este sitio.');
        }
    }

    public function register_admin_menu() {
        add_options_page(
            'ConsentHub Espanol',
            'ConsentHub',
            'manage_options',
            'consenthub-espanol',
            array('ConsentHubAdmin', 'render_settings_page')
        );
    }

    public function register_settings() {
        register_setting('consenthub_es_settings', 'consenthub_site_id');
        register_setting('consenthub_es_settings', 'consenthub_api_url');
        register_setting('consenthub_es_settings', 'consenthub_api_key');
        register_setting('consenthub_es_settings', 'consenthub_country');
        register_setting('consenthub_es_settings', 'consenthub_banner_title');
        register_setting('consenthub_es_settings', 'consenthub_banner_text');
        register_setting('consenthub_es_settings', 'consenthub_default_analytics');
        register_setting('consenthub_es_settings', 'consenthub_default_marketing');
        register_setting('consenthub_es_settings', 'consenthub_setup_complete');
        register_setting('consenthub_es_settings', 'consenthub_legal_disclaimer');
        register_setting('consenthub_es_settings', 'consenthub_cookie_policy_template');
        register_setting('consenthub_es_settings', 'consenthub_privacy_policy_template');
    }

    public function enqueue_assets() {
        wp_enqueue_style(
            'consenthub-es-css',
            plugin_dir_url(__FILE__) . 'assets/css/consenthub.css',
            array(),
            '0.1.0'
        );

        wp_enqueue_script(
            'consenthub-es-js',
            plugin_dir_url(__FILE__) . 'assets/js/consenthub.js',
            array(),
            '0.1.0',
            true
        );

        wp_localize_script('consenthub-es-js', 'ConsentHubConfig', array(
            'siteId' => get_option('consenthub_site_id', parse_url(home_url(), PHP_URL_HOST)),
            'proxyUrl' => admin_url('admin-ajax.php?action=consenthub_track_event'),
            'proxyNonce' => wp_create_nonce('consenthub_track_event'),
            'country' => get_option('consenthub_country', 'CL'),
            'bannerTitle' => get_option('consenthub_banner_title', 'Tu privacidad importa'),
            'bannerText' => get_option('consenthub_banner_text', 'Usamos cookies para mejorar tu experiencia. Puedes aceptar, rechazar o personalizar.'),
            'defaultAnalytics' => get_option('consenthub_default_analytics', '0') === '1',
            'defaultMarketing' => get_option('consenthub_default_marketing', '0') === '1',
            'policyUrl' => esc_url(home_url('/politica-de-cookies')),
        ));
    }

    public function handle_track_event() {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            wp_send_json_error(array('error' => 'Method not allowed'), 405);
        }

        $nonce = '';
        if (isset($_SERVER['HTTP_X_CONSENTHUB_NONCE'])) {
            $nonce = sanitize_text_field(wp_unslash($_SERVER['HTTP_X_CONSENTHUB_NONCE']));
        }

        if (!wp_verify_nonce($nonce, 'consenthub_track_event')) {
            wp_send_json_error(array('error' => 'Invalid nonce'), 403);
        }

        $raw = file_get_contents('php://input');
        $payload = json_decode($raw, true);
        if (!is_array($payload)) {
            wp_send_json_error(array('error' => 'Invalid payload'), 400);
        }

        $category = isset($payload['category']) ? sanitize_text_field(wp_unslash($payload['category'])) : '';
        $action = isset($payload['action']) ? sanitize_text_field(wp_unslash($payload['action'])) : '';

        $allowed_categories = array('all', 'necessary', 'analytics', 'marketing');
        $allowed_actions = array('accept_all', 'reject_non_essential', 'custom_preferences');

        if (!in_array($category, $allowed_categories, true) || !in_array($action, $allowed_actions, true)) {
            wp_send_json_error(array('error' => 'Invalid category or action'), 400);
        }

        $api_url = esc_url_raw(get_option('consenthub_api_url', ''));
        $api_key = sanitize_text_field(get_option('consenthub_api_key', ''));
        $site_id = sanitize_text_field(get_option('consenthub_site_id', parse_url(home_url(), PHP_URL_HOST)));
        $country = sanitize_text_field(get_option('consenthub_country', 'CL'));

        if (empty($api_url) || empty($api_key) || empty($site_id)) {
            wp_send_json_error(array('error' => 'Plugin not configured'), 500);
        }

        $response = wp_remote_post($api_url, array(
            'timeout' => 5,
            'headers' => array(
                'Content-Type' => 'application/json',
                'x-api-key' => $api_key,
            ),
            'body' => wp_json_encode(array(
                'site' => $site_id,
                'country' => $country,
                'action' => $action,
                'category' => $category,
            )),
        ));

        if (is_wp_error($response)) {
            wp_send_json_error(array('error' => 'Upstream request failed'), 502);
        }

        $status = wp_remote_retrieve_response_code($response);
        if ($status < 200 || $status >= 300) {
            wp_send_json_error(array('error' => 'Upstream rejected event', 'status' => $status), 502);
        }

        wp_send_json_success(array('ok' => true), 200);
    }

    public function render_banner() {
        ?>
        <div id="consenthub-banner" class="consenthub-banner" hidden>
            <div class="consenthub-content">
                <h3 id="consenthub-title"></h3>
                <p id="consenthub-text"></p>
                <a class="consenthub-policy-link" href="<?php echo esc_url(home_url('/politica-de-cookies')); ?>">Leer politica de cookies</a>
                <div class="consenthub-actions">
                    <button id="consenthub-accept" class="consenthub-btn consenthub-btn-primary">Aceptar todo</button>
                    <button id="consenthub-reject" class="consenthub-btn consenthub-btn-secondary">Rechazar no esenciales</button>
                    <button id="consenthub-open-preferences" class="consenthub-btn consenthub-btn-secondary">Personalizar</button>
                </div>
            </div>
        </div>

        <div id="consenthub-modal" class="consenthub-modal" hidden>
            <div class="consenthub-modal-content" role="dialog" aria-modal="true" aria-labelledby="consenthub-modal-title">
                <h3 id="consenthub-modal-title">Preferencias de cookies</h3>
                <p>Elige las categorias que quieres permitir.</p>
                <label><input type="checkbox" checked disabled /> Necesarias (siempre activas)</label>
                <label><input id="consenthub-analytics" type="checkbox" /> Analitica</label>
                <label><input id="consenthub-marketing" type="checkbox" /> Marketing</label>
                <div class="consenthub-actions">
                    <button id="consenthub-save-preferences" class="consenthub-btn consenthub-btn-primary">Guardar preferencias</button>
                    <button id="consenthub-close-modal" class="consenthub-btn consenthub-btn-secondary">Cancelar</button>
                </div>
            </div>
        </div>
        <?php
    }
}

new ConsentHubPlugin();
