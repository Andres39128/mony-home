/**
 * Tour registry: one guided tour per page, driven by driver.js.
 *
 * Steps anchor to real UI elements via `data-tour="<element>"` attributes
 * (stable IDs, never CSS class selectors). Every entry here must have a
 * matching `data-tour` attribute on the target page; steps whose anchor is
 * missing at runtime (e.g. admin-only controls seen by a member) are skipped.
 */

export interface TourStep {
  /** Unique kebab-id within the page (also the unit-test uniqueness key). */
  id: string;
  /** Value of the `data-tour` attribute anchoring this step. */
  element: string;
  title: string;
  description: string;
}

/** Selector driver.js should highlight for a registry step. */
export function tourSelector(step: Pick<TourStep, "element">): string {
  return `[data-tour="${step.element}"]`;
}

/** localStorage flag set when the dashboard auto-tour ends (or is skipped). */
export const TOUR_STORAGE_KEY = "mony-tour-v1-seen";

/** Route ("/") that auto-launches its tour on first visit. */
export const TOUR_AUTO_LAUNCH_ROUTE = "/";

/** driver.js chrome copy, in the app's UI language. */
export const TOUR_LABELS = {
  nextBtnText: "Siguiente",
  prevBtnText: "Anterior",
  doneBtnText: "Entendido",
  progressText: "{{current}} de {{total}}",
} as const;

export const TOURS: Record<string, readonly TourStep[]> = {
  "/": [
    {
      id: "dashboard-kpis",
      element: "dashboard-kpis",
      title: "Resumen del mes",
      description:
        "Ingresos, gastos, saldo y porcentaje del presupuesto ejecutado. La barra del presupuesto muestra cuánto llevás gastado del total planificado.",
    },
    {
      id: "dashboard-filtros",
      element: "dashboard-filtros",
      title: "Filtros",
      description:
        "Elegí mes, ámbito, integrante, categoría, bolsa o grupo. Todo lo que ves abajo se recalcula con estos filtros.",
    },
    {
      id: "dashboard-donut",
      element: "dashboard-donut",
      title: "Gastos por categoría",
      description:
        "Cada porción es una categoría del mes. Hacé clic en una porción para ver los movimientos que la componen.",
    },
    {
      id: "dashboard-barras",
      element: "dashboard-barras",
      title: "Ingresos vs Gastos · 12 meses",
      description:
        "Comparativa del último año. Hacé clic en una barra para cambiar el dashboard a ese mes.",
    },
    {
      id: "dashboard-acumulado",
      element: "dashboard-acumulado",
      title: "Presupuesto acumulado",
      description:
        "Líneas del año: cuánto estaba presupuestado acumulado vs cuánto se gastó realmente, mes a mes.",
    },
    {
      id: "dashboard-bolsas",
      element: "dashboard-bolsas",
      title: "Bolsas del mes",
      description:
        "Avance de cada bolsa del hogar. Hacé clic en una bolsa para ver sus movimientos de este mes.",
    },
    {
      id: "dashboard-patrimonio",
      element: "dashboard-patrimonio",
      title: "Patrimonio",
      description:
        "Lo que tenés ahorrado e invertido en total. No cuenta ingresos ni gastos del mes: es plata acumulada. Hacé clic para ver el detalle en Ahorro.",
    },
  ],
  "/ahorro": [
    {
      id: "ahorro-patrimonio",
      element: "ahorro-patrimonio",
      title: "Patrimonio",
      description:
        "Total ahorrado del hogar, dividido en metas de ahorro e inversiones. Los aportes no son gastos ni ingresos: viven aparte de los movimientos.",
    },
    {
      id: "ahorro-metas",
      element: "ahorro-metas",
      title: "Metas e inversiones",
      description:
        "Una meta acumula plata (con objetivo y plazo opcionales); una inversión guarda además su valor actual y el retorno respecto de lo invertido.",
    },
    {
      id: "ahorro-aporte",
      element: "ahorro-aporte",
      title: "Aporte rápido",
      description:
        "Escribí el monto, elegí depósito o retiro y presioná Enter: se guarda al instante. El monto queda listo para el próximo aporte.",
    },
    {
      id: "ahorro-valor",
      element: "ahorro-valor",
      title: "Actualizar valor (admin)",
      description:
        "El valor de una inversión no se calcula solo: actualizalo a mano cuando cambie y el retorno se recalcula.",
    },
    {
      id: "ahorro-crear",
      element: "ahorro-crear",
      title: "Nueva meta (admin)",
      description:
        "Formulario para crear una meta de ahorro o una inversión del hogar, común o individual.",
    },
  ],
  "/movimientos": [
    {
      id: "movimientos-nuevo",
      element: "movimientos-nuevo",
      title: "Nuevo movimiento",
      description:
        "Botón para registrar un ingreso o gasto. Atajo de teclado: la tecla N abre el mismo formulario.",
    },
    {
      id: "movimientos-filtros",
      element: "movimientos-filtros",
      title: "Filtros compartibles",
      description:
        "Los filtros quedan en la dirección de la página: podés copiar el enlace y compartir la vista filtrada.",
    },
    {
      id: "movimientos-totales",
      element: "movimientos-totales",
      title: "Totales del período",
      description:
        "Suma de ingresos, gastos y saldo según los filtros aplicados.",
    },
    {
      id: "movimientos-tabla",
      element: "movimientos-tabla",
      title: "Lista de movimientos",
      description:
        "Cada fila se puede editar o borrar desde su fila. Solo podés modificar tus propios movimientos, salvo que seas administrador.",
    },
  ],
  "/presupuesto": [
    {
      id: "presupuesto-resumen",
      element: "presupuesto-resumen",
      title: "Resumen del mes",
      description:
        "Cuánto hay presupuestado, cuánto se gastó, el porcentaje ejecutado y los ingresos del mes.",
    },
    {
      id: "presupuesto-tabla",
      element: "presupuesto-tabla",
      title: "Avance por categoría",
      description:
        "Cada barra muestra el gasto contra lo presupuestado: verde cuando va bien, amarillo al acercarse al límite y rojo al pasarse.",
    },
    {
      id: "presupuesto-editor",
      element: "presupuesto-editor",
      title: "Editar montos (admin)",
      description:
        "Acá se define cuánto se planea gastar por categoría. \"Copiar mes anterior\" rellena todo con los montos del mes previo.",
    },
  ],
  "/bolsas": [
    {
      id: "bolsas-lista",
      element: "bolsas-lista",
      title: "Bolsas",
      description:
        "Dinero separado por objetivo: la bolsa Común es del hogar y las individuales son de cada integrante. La barra muestra cuánto llevás gastado del mes.",
    },
    {
      id: "bolsas-editar",
      element: "bolsas-editar",
      title: "Editar una bolsa (admin)",
      description:
        "Clic en \"Editar\" para desplegar el formulario de edición: nombre, monto mensual, tipo e integrante.",
    },
    {
      id: "bolsas-crear",
      element: "bolsas-crear",
      title: "Nueva bolsa (admin)",
      description: "Formulario para crear una bolsa nueva del hogar.",
    },
  ],
  "/asistente": [
    {
      id: "asistente-cuota",
      element: "asistente-cuota",
      title: "Cuota diaria",
      description:
        "Cuántas preguntas te quedan hoy. La cuota se reinicia cada día.",
    },
    {
      id: "asistente-limites",
      element: "asistente-limites",
      title: "Privacidad",
      description:
        "El asistente solo ve totales y promedios del mes, nunca tus movimientos individuales.",
    },
    {
      id: "asistente-input",
      element: "asistente-input",
      title: "Tu pregunta",
      description:
        "Escribí qué querés saber de las finanzas del hogar y presioná Enviar. Si el servicio no está disponible, te avisa.",
    },
  ],
  "/integrantes": [
    {
      id: "integrantes-crear",
      element: "integrantes-crear",
      title: "Nuevo integrante (admin)",
      description:
        "Formulario para dar de alta a alguien del hogar: usuario, nombre, contraseña y rol.",
    },
    {
      id: "integrantes-editar",
      element: "integrantes-editar",
      title: "Editar o desactivar (admin)",
      description:
        "Clic en \"Editar\" para desplegar el formulario. Si el integrante tiene movimientos no se puede borrar: desactivarlo para que deje de usar el sistema.",
    },
  ],
  "/categorias": [
    {
      id: "categorias-crear",
      element: "categorias-crear",
      title: "Nueva categoría (admin)",
      description:
        "Formulario para crear categorías de gastos o ingresos, con su color para los gráficos.",
    },
    {
      id: "categorias-editar",
      element: "categorias-editar",
      title: "Editar una categoría (admin)",
      description:
        "Clic en \"Editar\" para desplegar el formulario. Si la categoría ya tiene movimientos no se puede borrar: desactivarla para ocultarla de los formularios.",
    },
  ],
  "/grupos": [
    {
      id: "grupos-crear",
      element: "grupos-crear",
      title: "Nuevo grupo (admin)",
      description:
        "Formulario para agrupar movimientos por proyecto u objetivo (por ejemplo, unas vacaciones).",
    },
    {
      id: "grupos-lista",
      element: "grupos-lista",
      title: "Grupos del hogar",
      description:
        "Cada grupo suma sus movimientos. Clic en \"Editar\" para cambiar nombre, estado o cerrarlo; el borrado está protegido si ya tiene movimientos.",
    },
  ],
};
