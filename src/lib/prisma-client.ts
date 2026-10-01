import { PrismaClient } from "@prisma/client";
import { loadAppEnvironment } from "./app-environment";

// Consumers construct clients only after existing app configuration is loaded.
// The artifact retains its prepared Prisma bytes; no generation occurs here.
loadAppEnvironment();
export { PrismaClient };
