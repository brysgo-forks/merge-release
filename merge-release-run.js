#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const bent = require("bent");
const git = require("simple-git")();
const { execSync } = require("child_process");
const { promisify } = require("util");

const getlog = promisify(git.log.bind(git));

const registries = [];

if (process.env.USE_GITHUB) {
  registries.unshift("https://npm.pkg.github.com");
}
if (process.env.USE_NPM) {
  registries.unshift("https://registry.npmjs.org/");
}
const manualRegistry =
  process.env.NPM_REGISTRY_URL || "https://registry.npmjs.org/";
if (!registries.includes(manualRegistry)) {
  registries.unshift(manualRegistry);
}

const getAll = registries.map((registry) => bent("json", registry));
const get = getAll[0]; // default to first repository for source of truth

const event = JSON.parse(
  fs.readFileSync("/github/workflow/event.json").toString()
);

const deployDir = path.join(process.cwd(), process.env.DEPLOY_DIR || "./");
const srcPackageDir = path.join(
  process.cwd(),
  process.env.SRC_PACKAGE_DIR || "./"
);

console.log("            using deploy directory : " + deployDir);
console.log("using src directory (package.json) : " + srcPackageDir);

let pkg = require(path.join(deployDir, "package.json"));

const run = async () => {
  if (!process.env.NPM_AUTH_TOKEN)
    throw new Error("Merge-release requires NPM_AUTH_TOKEN");
  let latest;
  try {
    latest = get(pkg.name + "/latest");
  } catch (e) {
    // unpublished
  }

  let messages;

  if (latest) {
    if (latest.gitHead === process.env.GITHUB_SHA)
      return console.log("SHA matches latest release, skipping.");
    if (latest.gitHead) {
      try {
        let logs = await getlog({
          from: latest.gitHead,
          to: process.env.GITHUB_SHA,
        });
        messages = logs.all.map((r) => r.message + "\n" + r.body);
      } catch (e) {
        latest = null;
      }
      // g.log({from: 'f0002b6c9710f818b9385aafeb1bde994fe3b370', to: '53a92ca2d1ea3c55977f44d93e48e31e37d0bc69'}, (err, l) => console.log(l.all.map(r => r.message + '\n' + r.body)))
    } else {
      latest = null;
    }
  }
  if (!latest) {
    messages = (event.commits || []).map(
      (commit) => commit.message + "\n" + commit.body
    );
  }

  let version = "patch";
  if (
    messages
      .map((message) => message.includes("BREAKING CHANGE"))
      .includes(true)
  ) {
    version = "major";
  } else if (
    messages
      .map((message) => message.toLowerCase().startsWith("feat"))
      .includes(true)
  ) {
    version = "minor";
  }

  const exec = (str, opts) => process.stdout.write(execSync(str, opts));

  let currentVersion = execSync(`npm view ${pkg.name} version`, {
    cwd: srcPackageDir,
  }).toString();
  exec(
    `npm version --allow-same-version=true --git-tag-version=false ${currentVersion} `,
    { cwd: srcPackageDir }
  );
  console.log("current:", currentVersion, "/", "version:", version);
  let newVersion = execSync(`npm version --git-tag-version=false ${version}`, {
    cwd: srcPackageDir,
  }).toString();
  exec(
    `npm version --allow-same-version=true --git-tag-version=false ${newVersion} `,
    { cwd: deployDir }
  );
  console.log("new version:", newVersion);
  registries.forEach((registry) =>
    exec("npm publish", { cwd: deployDir, env: { NPM_REGISTRY_URL: registry } })
  );
  exec(`git checkout package.json`); // cleanup
  exec(`git tag ${newVersion}`);
  exec(`echo "::set-output name=version::${newVersion}"`); // set action event.{STEP_ID}.output.version

  /*
  const env = process.env
  const remote = `https://${env.GITHUB_ACTOR}:${env.GITHUB_TOKEN}@github.com/${env.GITHUB_REPOSITORY}.git`
  exec(`git push ${remote} --tags`)
  */
};
run();
