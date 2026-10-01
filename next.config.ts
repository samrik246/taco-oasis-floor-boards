import type { NextConfig } from "next";
import {execFileSync} from "node:child_process";
import {existsSync,readFileSync} from "node:fs";
const sourceSha=existsSync(".git")?execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim():readFileSync("RELEASE_SHA","utf8").trim();

const nextConfig: NextConfig = {
  env:{NEXT_PUBLIC_QUARTER_SOURCE_SHA:sourceSha},
};

export default nextConfig;
