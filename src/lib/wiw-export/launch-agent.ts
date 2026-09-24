/**
 * The LaunchAgent for the When I Work export: 07:00 and 16:00 local time, for
 * the user that runs the boards, in that user's logged-in GUI session (the
 * browser is headed). If the Mac is asleep at a slot, launchd runs the job on
 * wake, and missed slots become one run.
 *
 * The job runs in apply mode: the When I Work schedule is the authority, so a
 * changed day imports with no Confirm.
 *
 * This only writes the plist text. Loading it is the onsite install step.
 */
import { DIR_ENV, MODE_ENV } from "@/lib/import/folder-import";
import { LOGIN_FILE_ENV, PROFILE_DIR_ENV } from "./run";

export const WIW_EXPORT_LABEL = "com.taco-oasis.wiw-export";

export type LaunchAgentInput = {
  appDir: string;
  nodePath: string;
  importDir: string;
  loginFile: string;
  profileDir: string;
};

function xml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function launchAgentPlist(input: LaunchAgentInput): string {
  const str = (v: string) => `<string>${xml(v)}</string>`;
  const env: Array<[string, string]> = [
    [DIR_ENV, input.importDir],
    [LOGIN_FILE_ENV, input.loginFile],
    [PROFILE_DIR_ENV, input.profileDir],
    [MODE_ENV, "apply"],
  ];
  const slot = (hour: number) =>
    `<dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>0</integer></dict>`;
  const log = `${input.appDir}/var/log/wiw-export.launchd.log`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    `<key>Label</key>${str(WIW_EXPORT_LABEL)}`,
    "<key>ProgramArguments</key><array>",
    str(input.nodePath),
    str(`${input.appDir}/node_modules/tsx/dist/cli.mjs`),
    str(`${input.appDir}/scripts/wiw-export.ts`),
    "</array>",
    `<key>WorkingDirectory</key>${str(input.appDir)}`,
    "<key>EnvironmentVariables</key><dict>",
    ...env.map(([k, v]) => `<key>${k}</key>${str(v)}`),
    "</dict>",
    `<key>StartCalendarInterval</key><array>${slot(7)}${slot(16)}</array>`,
    "<key>RunAtLoad</key><false/>",
    "<key>LimitLoadToSessionType</key><string>Aqua</string>",
    `<key>StandardOutPath</key>${str(log)}`,
    `<key>StandardErrorPath</key>${str(log)}`,
    "</dict></plist>",
    "",
  ].join("\n");
}
