<?php

if (!defined('ABSPATH')) {
    exit;
}

class ConsentHubAdmin {
    private static function is_ingest_like_key($key) {
        $safe_key = sanitize_text_field((string) $key);
        return strpos($safe_key, 'ch_ing_') === 0;
    }

    private static function render_api_key_scope_warning() {
        $api_key = get_option('consenthub_api_key', '');
        if (empty($api_key)) {
            return;
        }

        if (self::is_ingest_like_key($api_key)) {
            return;
        }
        ?>
        <div style="background:#fff7ed;border:1px solid #fdba74;border-radius:8px;padding:10px;margin:12px 0;max-width:760px;">
            <strong>Recomendacion de seguridad:</strong>
            <p style="margin:6px 0 0;">La API key configurada no parece ser de tipo <code>ingest</code>. Para minimo privilegio, usa una clave con prefijo <code>ch_ing_</code> generada desde el dashboard de ConsentHub.</p>
        </div>
        <?php
    }

    public static function is_setup_complete() {
        return get_option('consenthub_setup_complete', '0') === '1';
    }

    public static function render_settings_page() {
        $show_wizard = !self::is_setup_complete() || isset($_GET['wizard']);

        if ($show_wizard) {
            self::render_wizard_page();
            return;
        }

        self::render_advanced_settings_page();
    }

    private static function render_wizard_page() {
        $step = isset($_GET['step']) ? max(1, min(3, intval($_GET['step']))) : 1;
        ?>
        <div class="wrap">
            <h1>ConsentHub - Asistente de configuracion</h1>
            <p>Configura el plugin en menos de 5 minutos para empezar a registrar consentimientos.</p>
            <p><strong>Paso <?php echo esc_html($step); ?> de 3</strong></p>

            <div style="background:#fff;border:1px solid #dcdcde;border-radius:8px;padding:16px;max-width:760px;">
                <?php if ($step === 1) : ?>
                    <h2>Paso 1: Sitio y pais</h2>
                    <p>Define identificador del sitio y pais por defecto.</p>
                    <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
                        <?php wp_nonce_field('consenthub_wizard_step'); ?>
                        <input type="hidden" name="action" value="consenthub_wizard_step" />
                        <input type="hidden" name="step" value="1" />

                        <table class="form-table" role="presentation">
                            <tr>
                                <th scope="row"><label for="consenthub_site_id">ID del sitio</label></th>
                                <td>
                                    <input name="consenthub_site_id" type="text" id="consenthub_site_id" value="<?php echo esc_attr(get_option('consenthub_site_id', parse_url(home_url(), PHP_URL_HOST))); ?>" class="regular-text" required>
                                    <p class="description">Usa el dominio de tu WordPress o un identificador interno.</p>
                                </td>
                            </tr>
                            <tr>
                                <th scope="row"><label for="consenthub_country">Pais por defecto</label></th>
                                <td>
                                    <select name="consenthub_country" id="consenthub_country">
                                        <?php $current = get_option('consenthub_country', 'CL'); ?>
                                        <option value="CL" <?php selected($current, 'CL'); ?>>Chile</option>
                                        <option value="AR" <?php selected($current, 'AR'); ?>>Argentina</option>
                                        <option value="CO" <?php selected($current, 'CO'); ?>>Colombia</option>
                                        <option value="MX" <?php selected($current, 'MX'); ?>>Mexico</option>
                                        <option value="PE" <?php selected($current, 'PE'); ?>>Peru</option>
                                    </select>
                                </td>
                            </tr>
                        </table>

                        <?php submit_button('Continuar al paso 2'); ?>
                    </form>
                <?php elseif ($step === 2) : ?>
                    <h2>Paso 2: Conexion con ConsentHub SaaS</h2>
                    <p>Conecta tu WordPress con la API para guardar eventos de consentimiento.</p>
                    <?php self::render_api_key_scope_warning(); ?>
                    <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
                        <?php wp_nonce_field('consenthub_wizard_step'); ?>
                        <input type="hidden" name="action" value="consenthub_wizard_step" />
                        <input type="hidden" name="step" value="2" />

                        <table class="form-table" role="presentation">
                            <tr>
                                <th scope="row"><label for="consenthub_api_url">URL API</label></th>
                                <td>
                                    <input name="consenthub_api_url" type="url" id="consenthub_api_url" value="<?php echo esc_attr(get_option('consenthub_api_url', 'http://localhost:8787/consent-events')); ?>" class="regular-text" required>
                                    <p class="description">Ejemplo: https://app.tudominio.com/consent-events</p>
                                </td>
                            </tr>
                            <tr>
                                <th scope="row"><label for="consenthub_api_key">API Key</label></th>
                                <td>
                                    <input name="consenthub_api_key" type="text" id="consenthub_api_key" value="<?php echo esc_attr(get_option('consenthub_api_key', '')); ?>" class="regular-text" required>
                                    <p class="description">Recomendado: clave scopeada de solo ingesta (prefijo <code>ch_ing_</code>).</p>
                                </td>
                            </tr>
                        </table>

                        <p>
                            <a class="button button-secondary" href="<?php echo esc_url(admin_url('options-general.php?page=consenthub-espanol&wizard=1&step=1')); ?>">Volver al paso 1</a>
                        </p>
                        <?php submit_button('Continuar al paso 3'); ?>
                    </form>
                <?php else : ?>
                    <h2>Paso 3: Banner inicial</h2>
                    <p>Define el texto base del banner, templates legales y preferencias iniciales del modal.</p>
                    <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
                        <?php wp_nonce_field('consenthub_wizard_step'); ?>
                        <input type="hidden" name="action" value="consenthub_wizard_step" />
                        <input type="hidden" name="step" value="3" />

                        <table class="form-table" role="presentation">
                            <tr>
                                <th scope="row"><label for="consenthub_banner_title">Titulo del banner</label></th>
                                <td><input name="consenthub_banner_title" type="text" id="consenthub_banner_title" value="<?php echo esc_attr(get_option('consenthub_banner_title', 'Tu privacidad importa')); ?>" class="regular-text" required></td>
                            </tr>
                            <tr>
                                <th scope="row"><label for="consenthub_banner_text">Texto del banner</label></th>
                                <td>
                                    <textarea name="consenthub_banner_text" id="consenthub_banner_text" rows="3" class="large-text" required><?php echo esc_textarea(get_option('consenthub_banner_text', 'Usamos cookies para mejorar tu experiencia. Puedes aceptar, rechazar o personalizar.')); ?></textarea>
                                </td>
                            </tr>
                            <tr>
                                <th scope="row">Preferencias iniciales sugeridas</th>
                                <td>
                                    <?php $default_analytics = get_option('consenthub_default_analytics', '0'); ?>
                                    <?php $default_marketing = get_option('consenthub_default_marketing', '0'); ?>
                                    <label><input type="checkbox" name="consenthub_default_analytics" value="1" <?php checked($default_analytics, '1'); ?> /> Activar Analitica por defecto</label>
                                    <br />
                                    <label><input type="checkbox" name="consenthub_default_marketing" value="1" <?php checked($default_marketing, '1'); ?> /> Activar Marketing por defecto</label>
                                </td>
                            </tr>
                            <tr>
                                <th scope="row"><label for="consenthub_legal_disclaimer">Disclaimer legal</label></th>
                                <td>
                                    <textarea name="consenthub_legal_disclaimer" id="consenthub_legal_disclaimer" rows="2" class="large-text" required><?php echo esc_textarea(get_option('consenthub_legal_disclaimer', 'ConsentHub facilita la implementacion tecnica de consentimiento, pero no constituye asesoria legal.')); ?></textarea>
                                </td>
                            </tr>
                            <tr>
                                <th scope="row"><label for="consenthub_cookie_policy_template">Plantilla politica de cookies</label></th>
                                <td>
                                    <textarea name="consenthub_cookie_policy_template" id="consenthub_cookie_policy_template" rows="7" class="large-text"><?php echo esc_textarea(get_option('consenthub_cookie_policy_template', 'Usamos cookies necesarias para el funcionamiento del sitio y, con tu consentimiento, cookies de analitica y marketing para mejorar la experiencia y medir resultados. Puedes cambiar tus preferencias en cualquier momento desde el banner de consentimiento.')); ?></textarea>
                                </td>
                            </tr>
                            <tr>
                                <th scope="row"><label for="consenthub_privacy_policy_template">Plantilla politica de privacidad</label></th>
                                <td>
                                    <textarea name="consenthub_privacy_policy_template" id="consenthub_privacy_policy_template" rows="7" class="large-text"><?php echo esc_textarea(get_option('consenthub_privacy_policy_template', 'Tratamos datos personales para operar este sitio, responder solicitudes y mejorar nuestros servicios. Cuando corresponde, solicitamos consentimiento para analitica y marketing. Puedes ejercer tus derechos de acceso, rectificacion y eliminacion contactandonos mediante los canales publicados en este sitio.')); ?></textarea>
                                </td>
                            </tr>
                        </table>

                        <p>
                            <a class="button button-secondary" href="<?php echo esc_url(admin_url('options-general.php?page=consenthub-espanol&wizard=1&step=2')); ?>">Volver al paso 2</a>
                        </p>
                        <?php submit_button('Finalizar configuracion'); ?>
                    </form>
                <?php endif; ?>
            </div>
        </div>
        <?php
    }

    private static function render_advanced_settings_page() {
        ?>
        <div class="wrap">
            <h1>ConsentHub Espanol</h1>
            <p>Configuracion avanzada del plugin. Si prefieres, puedes reiniciar el asistente.</p>
            <?php self::render_api_key_scope_warning(); ?>
            <div style="background:#fff;border:1px solid #dcdcde;border-radius:8px;padding:12px;max-width:760px;margin-bottom:12px;">
                <h2 style="margin-top:0;">Guia rapida de bloqueo por categoria</h2>
                <p>Marca scripts no esenciales con <code>type="text/plain"</code> y <code>data-consenthub-category="analytics"</code> o <code>data-consenthub-category="marketing"</code>.</p>
                <p>ConsentHub ejecutara esos scripts solo cuando el usuario acepte la categoria correspondiente.</p>
            </div>
            <div style="background:#fff8e1;border:1px solid #e5c07b;border-radius:8px;padding:12px;max-width:760px;margin-bottom:12px;">
                <strong>Nota legal:</strong>
                <p style="margin:8px 0 0;"><?php echo esc_html(get_option('consenthub_legal_disclaimer', 'ConsentHub facilita la implementacion tecnica de consentimiento, pero no constituye asesoria legal.')); ?></p>
            </div>
            <p>
                <a class="button button-secondary" href="<?php echo esc_url(admin_url('options-general.php?page=consenthub-espanol&wizard=1&step=1')); ?>">Reiniciar asistente</a>
            </p>

            <form method="post" action="options.php">
                <?php settings_fields('consenthub_es_settings'); ?>
                <?php do_settings_sections('consenthub_es_settings'); ?>

                <table class="form-table" role="presentation">
                    <tr>
                        <th scope="row"><label for="consenthub_site_id">ID del sitio</label></th>
                        <td><input name="consenthub_site_id" type="text" id="consenthub_site_id" value="<?php echo esc_attr(get_option('consenthub_site_id', parse_url(home_url(), PHP_URL_HOST))); ?>" class="regular-text"></td>
                    </tr>
                    <tr>
                        <th scope="row"><label for="consenthub_api_url">URL API</label></th>
                        <td><input name="consenthub_api_url" type="text" id="consenthub_api_url" value="<?php echo esc_attr(get_option('consenthub_api_url', 'http://localhost:8787/consent-events')); ?>" class="regular-text"></td>
                    </tr>
                    <tr>
                        <th scope="row"><label for="consenthub_api_key">API Key</label></th>
                        <td><input name="consenthub_api_key" type="text" id="consenthub_api_key" value="<?php echo esc_attr(get_option('consenthub_api_key', '')); ?>" class="regular-text"></td>
                    </tr>
                    <tr>
                        <th scope="row"><label for="consenthub_country">Pais por defecto</label></th>
                        <td>
                            <select name="consenthub_country" id="consenthub_country">
                                <?php $current = get_option('consenthub_country', 'CL'); ?>
                                <option value="CL" <?php selected($current, 'CL'); ?>>Chile</option>
                                <option value="AR" <?php selected($current, 'AR'); ?>>Argentina</option>
                                <option value="CO" <?php selected($current, 'CO'); ?>>Colombia</option>
                                <option value="MX" <?php selected($current, 'MX'); ?>>Mexico</option>
                                <option value="PE" <?php selected($current, 'PE'); ?>>Peru</option>
                            </select>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row"><label for="consenthub_banner_title">Titulo del banner</label></th>
                        <td><input name="consenthub_banner_title" type="text" id="consenthub_banner_title" value="<?php echo esc_attr(get_option('consenthub_banner_title', 'Tu privacidad importa')); ?>" class="regular-text"></td>
                    </tr>
                    <tr>
                        <th scope="row"><label for="consenthub_banner_text">Texto del banner</label></th>
                        <td>
                            <textarea name="consenthub_banner_text" id="consenthub_banner_text" rows="3" class="large-text"><?php echo esc_textarea(get_option('consenthub_banner_text', 'Usamos cookies para mejorar tu experiencia. Puedes aceptar, rechazar o personalizar.')); ?></textarea>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row">Preferencias iniciales sugeridas</th>
                        <td>
                            <?php $default_analytics = get_option('consenthub_default_analytics', '0'); ?>
                            <?php $default_marketing = get_option('consenthub_default_marketing', '0'); ?>
                            <label><input type="checkbox" name="consenthub_default_analytics" value="1" <?php checked($default_analytics, '1'); ?> /> Activar Analitica por defecto</label>
                            <br />
                            <label><input type="checkbox" name="consenthub_default_marketing" value="1" <?php checked($default_marketing, '1'); ?> /> Activar Marketing por defecto</label>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row"><label for="consenthub_legal_disclaimer">Disclaimer legal</label></th>
                        <td>
                            <textarea name="consenthub_legal_disclaimer" id="consenthub_legal_disclaimer" rows="2" class="large-text"><?php echo esc_textarea(get_option('consenthub_legal_disclaimer', 'ConsentHub facilita la implementacion tecnica de consentimiento, pero no constituye asesoria legal.')); ?></textarea>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row"><label for="consenthub_cookie_policy_template">Plantilla politica de cookies</label></th>
                        <td>
                            <textarea name="consenthub_cookie_policy_template" id="consenthub_cookie_policy_template" rows="8" class="large-text"><?php echo esc_textarea(get_option('consenthub_cookie_policy_template', 'Usamos cookies necesarias para el funcionamiento del sitio y, con tu consentimiento, cookies de analitica y marketing para mejorar la experiencia y medir resultados. Puedes cambiar tus preferencias en cualquier momento desde el banner de consentimiento.')); ?></textarea>
                            <p class="description">Puedes copiar este contenido a tu pagina de politica de cookies y adaptarlo a tu caso.</p>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row"><label for="consenthub_privacy_policy_template">Plantilla politica de privacidad</label></th>
                        <td>
                            <textarea name="consenthub_privacy_policy_template" id="consenthub_privacy_policy_template" rows="8" class="large-text"><?php echo esc_textarea(get_option('consenthub_privacy_policy_template', 'Tratamos datos personales para operar este sitio, responder solicitudes y mejorar nuestros servicios. Cuando corresponde, solicitamos consentimiento para analitica y marketing. Puedes ejercer tus derechos de acceso, rectificacion y eliminacion contactandonos mediante los canales publicados en este sitio.')); ?></textarea>
                            <p class="description">Incluye finalidades, base legal, plazos de retencion y canal de contacto para derechos ARCO.</p>
                        </td>
                    </tr>
                </table>

                <?php submit_button('Guardar cambios'); ?>
            </form>
        </div>
        <?php
    }

    public static function handle_wizard_step() {
        if (!current_user_can('manage_options')) {
            wp_die('No tienes permisos para realizar esta accion.');
        }

        check_admin_referer('consenthub_wizard_step');

        $step = isset($_POST['step']) ? intval($_POST['step']) : 1;

        if ($step === 1) {
            if (isset($_POST['consenthub_site_id'])) {
                update_option('consenthub_site_id', sanitize_text_field(wp_unslash($_POST['consenthub_site_id'])));
            }
            if (isset($_POST['consenthub_country'])) {
                update_option('consenthub_country', sanitize_text_field(wp_unslash($_POST['consenthub_country'])));
            }
            wp_safe_redirect(admin_url('options-general.php?page=consenthub-espanol&wizard=1&step=2'));
            exit;
        }

        if ($step === 2) {
            if (isset($_POST['consenthub_api_url'])) {
                update_option('consenthub_api_url', esc_url_raw(wp_unslash($_POST['consenthub_api_url'])));
            }
            if (isset($_POST['consenthub_api_key'])) {
                update_option('consenthub_api_key', sanitize_text_field(wp_unslash($_POST['consenthub_api_key'])));
            }
            wp_safe_redirect(admin_url('options-general.php?page=consenthub-espanol&wizard=1&step=3'));
            exit;
        }

        if (isset($_POST['consenthub_banner_title'])) {
            update_option('consenthub_banner_title', sanitize_text_field(wp_unslash($_POST['consenthub_banner_title'])));
        }
        if (isset($_POST['consenthub_banner_text'])) {
            update_option('consenthub_banner_text', sanitize_textarea_field(wp_unslash($_POST['consenthub_banner_text'])));
        }
        if (isset($_POST['consenthub_legal_disclaimer'])) {
            update_option('consenthub_legal_disclaimer', sanitize_textarea_field(wp_unslash($_POST['consenthub_legal_disclaimer'])));
        }
        if (isset($_POST['consenthub_cookie_policy_template'])) {
            update_option('consenthub_cookie_policy_template', sanitize_textarea_field(wp_unslash($_POST['consenthub_cookie_policy_template'])));
        }
        if (isset($_POST['consenthub_privacy_policy_template'])) {
            update_option('consenthub_privacy_policy_template', sanitize_textarea_field(wp_unslash($_POST['consenthub_privacy_policy_template'])));
        }

        update_option('consenthub_default_analytics', isset($_POST['consenthub_default_analytics']) ? '1' : '0');
        update_option('consenthub_default_marketing', isset($_POST['consenthub_default_marketing']) ? '1' : '0');
        update_option('consenthub_setup_complete', '1');

        wp_safe_redirect(admin_url('options-general.php?page=consenthub-espanol&setup=done'));
        exit;
    }
}
