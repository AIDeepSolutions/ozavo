"use client";

import en from "../../../i18n/en/finops";
import es from "../../../i18n/es/finops";
import ptBR from "../../../i18n/pt-BR/finops";
import { useDict } from "../../../i18n/provider";
import { useApi } from "../../../ui/api";
import { ActionStatus, useAction } from "../../../ui/errors";
import { Field, Panel, Select, Switch } from "../../../ui/kit";
import { useCanConfigure } from "../../../ui/me";
import type { Setting } from "../../../ui/types";
import { put } from "../settings/setting-api";

/**
 * Por onde mais sai o aviso de 80% e de 100% da franquia, além do painel. É escolha da própria
 * empresa (dono ou administrador): onde ela quer ser avisada não afrouxa limite nenhum.
 */
export function AlertDeliveryPanel() {
  const t = useDict(ptBR, en, es);
  const canConfigure = useCanConfigure();
  const whatsapp = useApi<Setting<boolean>>("/settings/plan.alert_whatsapp");
  const webhook = useApi<Setting<string>>("/settings/plan.alert_webhook");
  const hooks = useApi<Setting<Array<{ name: string }>>>("/settings/webhooks.allowed");
  const saveWhatsapp = useAction();
  const saveWebhook = useAction();
  const names = (hooks.data?.value ?? []).map((hook) => hook.name);
  const chosen = webhook.data?.value ?? "";

  return (
    <Panel title={t.alertsTitle} description={t.alertsLead}>
      <div className="grid gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Switch
            label={t.alertsWhatsapp}
            disabled={!canConfigure || saveWhatsapp.busy || !whatsapp.data}
            checked={whatsapp.data?.value === true}
            onChange={(next) => void saveWhatsapp.run(() => put("plan.alert_whatsapp", next)).then(whatsapp.reload)}
          />
          <ActionStatus action={saveWhatsapp} />
        </div>
        <Field label={t.alertsWebhook} hint={t.alertsWebhookHint}>
          <Select
            disabled={!canConfigure || saveWebhook.busy || !webhook.data}
            value={chosen}
            onChange={(event) => void saveWebhook.run(() => put("plan.alert_webhook", event.target.value === "" ? null : event.target.value)).then(webhook.reload)}
          >
            <option value="">{t.alertsWebhookNone}</option>
            {[...new Set(chosen === "" ? names : [chosen, ...names])].map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </Select>
        </Field>
        <ActionStatus action={saveWebhook} />
      </div>
    </Panel>
  );
}
