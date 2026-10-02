import { getDb } from "@/db";
import { requireUser } from "@/features/auth/session";
import { getAppSettings, getFxRates } from "@/lib/app-settings";
import { setAppSettingsAction, setFxRateAction } from "@/features/settings/actions";
import ConfigForm from "./config-form";
import FxRatesForm from "./fx-rates-form";

export default async function ConfiguracionPage() {
  const user = await requireUser();
  const settings = await getAppSettings(getDb());
  const fxRates = await getFxRates(getDb());
  const rates = Object.entries(fxRates)
    .map(([code, rate]) => ({ code, rate }))
    .sort((a, b) => a.code.localeCompare(b.code));

  return (
    <section className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Configuración</h1>
      <ConfigForm
        current={settings}
        isAdmin={user.role === "admin"}
        action={setAppSettingsAction}
      />
      <FxRatesForm
        rates={rates}
        baseCurrency={settings.currencyCode}
        isAdmin={user.role === "admin"}
        action={setFxRateAction}
      />
    </section>
  );
}
