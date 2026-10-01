import { handleImport } from "@/lib/import/http";
export const runtime="nodejs";
export async function POST(request:Request){return handleImport(request,true);}
