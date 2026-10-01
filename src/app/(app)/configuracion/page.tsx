import { getDb } from "@/db";
import { requireUser } from "@/features/auth/session";
import { getAppSettings } from "@/lib/app-settings";
import { setAppSettingsAction } from "@/features/settings/actions";
import ConfigForm from "./config-form";

export default async function ConfiguracionPage() {
  const user = await requireUser();
  const settings = await getAppSettings(getDb());

  return (
    <section className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Configuración</h1>
      <ConfigForm
        current={settings}
        isAdmin={user.role === "admin"}
        action={setAppSettingsAction}
      />
    </section>
  );
}
