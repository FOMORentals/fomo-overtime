import { cookies } from "next/headers";
import { COOKIE, verifyAdminToken } from "./admin-link";

export async function adminEmail(): Promise<string | null> {
  return verifyAdminToken((await cookies()).get(COOKIE)?.value);
}
