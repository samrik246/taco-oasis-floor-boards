import { boardWrite } from "@/lib/shared-write";
import { requireLegacy,quarterState,type QuarterDb } from "@/lib/quarter/schema";
import { prisma } from "@/lib/db";
import {
  allLoadStationDefs,
  loadStationsForBoard,
} from "@/lib/load-stations";
import type { FloorBoardId } from "@/lib/board-config";
import {
  emptyMeters,
  metersFromCounts,
  simulateTick,
  TRAFFIC_TICK_MS,
  type TrafficStateSnapshot,
} from "@/lib/traffic/simulator";
import { processReturnToStation } from "@/lib/tareas/return-service";

async function ensureConfig(db:QuarterDb) {
  return db.trafficSimulatorConfig.upsert({
    where: { id: "default" },
    create: { id: "default", enabled: false },
    update: {},
  });
}

async function ensureMeters(db:QuarterDb) {
  for (const s of allLoadStationDefs()) {
    await db.loadStationMeter.upsert({
      where: { loadStationId: s.id },
      create: {
        loadStationId: s.id,
        level: "quiet",
        orderCount: 0,
      },
      update: {},
    });
  }
}

function snapshotForBoard(
  enabled: boolean,
  lastTickAt: Date | null,
  rows: { loadStationId: string; level: string; orderCount: number }[],
  board?: FloorBoardId,
): TrafficStateSnapshot {
  const stations = board
    ? loadStationsForBoard(board)
    : allLoadStationDefs();
  const byId = Object.fromEntries(rows.map((r) => [r.loadStationId, r]));
  const meters = stations.map((s) => {
    const row = byId[s.id];
    return {
      loadStationId: s.id,
      label: s.label,
      level: (row?.level ?? "quiet") as "quiet" | "busy" | "slammed",
      orderCount: row?.orderCount ?? 0,
      seatIds: s.seatIds,
      board: s.board,
    };
  });
  return {
    enabled,
    lastTickAt: lastTickAt?.toISOString() ?? null,
    meters: meters.length ? meters : emptyMeters(board),
  };
}

export async function getTrafficState(board?:FloorBoardId):Promise<TrafficStateSnapshot>{
  return prisma.$transaction(async db=>{
    // Reading active boards never seeds configuration, meters or a lock row.
    const config=await db.trafficSimulatorConfig.findUnique({where:{id:"default"}});
    const rows=await db.loadStationMeter.findMany();
    return snapshotForBoard(config?.enabled??false,config?.lastTickAt??null,rows,board);
  });
}
export async function setTrafficEnabled(enabled:boolean,board?:FloorBoardId):Promise<TrafficStateSnapshot>{
  await boardWrite(prisma,async db=>{
    if(enabled)await requireLegacy(db);
    await ensureConfig(db);
    await db.trafficSimulatorConfig.update({where:{id:"default"},data:{enabled}});
  });
  return enabled?tickTrafficIfDue({force:true,board}):getTrafficState(board);
}
/** Dormant simulator writes share the mutex and explicitly refuse an active schema. */
export async function tickTrafficIfDue(opts?:{force?:boolean;date?:string;hour?:number;board?:FloorBoardId}):Promise<TrafficStateSnapshot>{
  const advanced=await boardWrite(prisma,async db=>{
    if((await quarterState(db))?.phase==="active"){await requireLegacy(db);}
    const config=await ensureConfig(db);await ensureMeters(db);
    const now=new Date();
    if(!config.enabled||(!opts?.force&&config.lastTickAt&&+now-+config.lastTickAt<TRAFFIC_TICK_MS))return false;
    const previous=await db.loadStationMeter.findMany();
    const counts=simulateTick({now,previousCounts:Object.fromEntries(previous.map(p=>[p.loadStationId,p.orderCount]))});
    for(const m of metersFromCounts(counts))await db.loadStationMeter.upsert({where:{loadStationId:m.loadStationId},
      create:{loadStationId:m.loadStationId,level:m.level,orderCount:m.orderCount},update:{level:m.level,orderCount:m.orderCount}});
    await db.trafficSimulatorConfig.update({where:{id:"default"},data:{lastTickAt:now}});return true;
  });
  if(advanced&&opts?.date!=null&&opts.hour!=null)await processReturnToStation({date:opts.date,hour:opts.hour,board:opts.board});
  return getTrafficState(opts?.board);
}
