import { quarterState } from "@/lib/quarter/schema";
import { resolvePaintWorld, assignedIntervals } from "@/lib/quarter/world";
import { prisma } from "@/lib/db";
import { paletteUseStart } from "@/lib/assignments/palette-order";

/**
 * Saved assignment rows per station on this board, for the 28 days before
 * `date`. The payload is station id and count only.
 */
export async function loadStationUse(
  board: "caja" | "cocina",
  date: string,
  stationIds: readonly string[],
): Promise<{ stationId: string; count: number }[]> {
  if (stationIds.length === 0) return [];
  if ((await quarterState(prisma))?.phase === "active") return prisma.$transaction(async tx => {
    const dates=await tx.shift.findMany({where:{board,date:{gte:paletteUseStart(date),lt:date}},select:{date:true},distinct:["date"]});
    const intervals:ReturnType<typeof assignedIntervals>=[];
    for(const row of dates)intervals.push(...assignedIntervals(await resolvePaintWorld(tx,row.date),false));
    return stationIds.map(stationId=>{
      const sorted=intervals.filter(s=>s.stationId===stationId).sort((a,b)=>a.startMs-b.startMs);
      let total=0,start=0,end=0;
      for(const s of sorted){if(s.startMs>end){total+=end-start;start=s.startMs;end=s.endMs;}else end=Math.max(end,s.endMs);}
      total+=end-start;return {stationId,count:total/60_000};
    });
  });
  const grouped = await prisma.assignment.groupBy({
    by: ["stationId"],
    where: {
      stationId: { in: [...stationIds] },
      shift: {
        board,
        date: { gte: paletteUseStart(date), lt: date },
      },
    },
    _count: { _all: true },
  });
  const counts = new Map(grouped.map((row) => [row.stationId, row._count._all]));
  return stationIds.map((stationId) => ({
    stationId,
    count: counts.get(stationId) ?? 0,
  }));
}
