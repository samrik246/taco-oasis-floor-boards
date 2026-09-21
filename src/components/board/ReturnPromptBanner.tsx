"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  formatReturnPromptMessage,
  type Locale,
  type Messages,
} from "@/lib/i18n";

export type ReturnPromptDto = {
  id: string;
  message: string;
  loadStationId: string;
  seatId: string;
  employee: { id: string; firstName: string; lastName: string };
};

type Props = {
  prompts: ReturnPromptDto[];
  mute: boolean;
  onMuteChange: (mute: boolean) => void;
  onAck: (id: string) => void;
  readonly: boolean;
  locale: Locale;
  t: Messages;
};

export function ReturnPromptBanner({
  prompts,
  mute,
  onMuteChange,
  onAck,
  readonly,
  locale,
  t,
}: Props) {
  if (prompts.length === 0) return null;

  return (
    <div
      className="mx-3 mt-3 space-y-2 sm:mx-4"
      data-testid="return-prompt-banner"
      role="alert"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-bold text-red-950">
          {t.returnToStation}
        </span>
        <label className="flex min-h-11 items-center gap-2 text-xs font-semibold">
          <input
            type="checkbox"
            className="size-4 accent-neutral-900"
            checked={mute}
            onChange={(e) => onMuteChange(e.target.checked)}
            data-testid="chime-mute"
          />
          {t.muteChime}
        </label>
      </div>
      {prompts.map((p) => {
        const displayName =
          `${p.employee.firstName} ${p.employee.lastName}`.trim();
        const onFloater =
          /floater|flotante/i.test(p.message) || p.seatId === "multi";
        const text = formatReturnPromptMessage(locale, {
          displayName,
          loadStationId: p.loadStationId,
          seatId: p.seatId,
          onFloater,
        });
        return (
          <div
            key={p.id}
            className={cn(
              "flex flex-wrap items-center justify-between gap-2 rounded-md border-2 border-red-900 bg-red-100 px-4 py-3 text-base font-semibold text-red-950",
            )}
            data-testid={`return-prompt-${p.id}`}
          >
            <span>{text}</span>
            {!readonly && (
              <Button
                type="button"
                size="lg"
                className="min-h-11 border-2 border-red-900 bg-white text-red-950"
                onClick={() => onAck(p.id)}
                data-testid={`ack-return-${p.id}`}
              >
                {t.acknowledge}
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}
