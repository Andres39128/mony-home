import { requireUser } from "@/features/auth/session";
import { getDb } from "@/db";
import { listCategories } from "@/features/categories/service";
import {
  createCategoryAction,
  deleteCategoryAction,
  toggleCategoryAction,
  updateCategoryAction,
} from "@/features/categories/actions";
import CategoriesPanel from "./categories-panel";

export default async function CategoriasPage() {
  const user = await requireUser();
  const categories = await listCategories(getDb());

  return (
    <section className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">
        Categorías
      </h1>
      <CategoriesPanel
        categories={categories}
        isAdmin={user.role === "admin"}
        createAction={createCategoryAction}
        updateAction={updateCategoryAction}
        toggleAction={toggleCategoryAction}
        deleteAction={deleteCategoryAction}
      />
    </section>
  );
}
