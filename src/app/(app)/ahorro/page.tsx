import { redirect } from "next/navigation";

/** The savings UI lives at /bolsas; this stub keeps old links working. */
export default function AhorroPage() {
  redirect("/bolsas");
}
