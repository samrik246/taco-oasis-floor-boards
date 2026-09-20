import { Button } from "@/components/ui/button";

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 p-8">
      <h1 className="text-3xl font-semibold tracking-tight">Taco Oasis Floor Boards</h1>
      <p className="max-w-md text-center text-neutral-600">
        Beta foundation: schedule import, station seeds, and day board APIs. UI
        board shell lands in later slices.
      </p>
      <div className="flex gap-2">
        <Button asChild>
          <a href="/api/days">Days API</a>
        </Button>
        <Button variant="outline" asChild>
          <a href="/api/boards/caja/days/2026-09-20">Sample Caja day</a>
        </Button>
      </div>
    </main>
  );
}
