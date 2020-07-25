#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const bent = require("bent");
const git = require("simple-git")();
const exec = require("@actions/exec");
const { promisify } = require("util");

const core = require("@actions/core");
const { GitHub, context } = require("@actions/github");

const github = new GitHub(process.env.GITHUB_TOKEN);
const { owner, repo } = context.repo;
const commitish =
  core.getInput("commitish", { required: false }) || context.sha;

try {
  const getlog = promisify(git.log.bind(git));

  const registries = [];

  if (core.getInput("USE_GITHUB")) {
    registries.unshift("https://npm.pkg.github.com");
  }
  if (core.getInput("USE_NPM")) {
    registries.unshift("https://registry.npmjs.org/");
  }
  if (core.getInput("OTHER_REGISTRY")) {
    registries.unshift(core.getInput("OTHER_REGISTRY"));
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

    let currentVersion = exec(`npm view ${pkg.name} version`, {
      cwd: srcPackageDir,
    }).toString();
    exec(
      `npm version --allow-same-version=true --git-tag-version=false ${currentVersion} `,
      srcPackageDir
    );
    console.log("current:", currentVersion, "/", "version:", version);
    let newVersion = exec(`npm version --git-tag-version=false ${version}`, {
      cwd: srcPackageDir,
    }).toString();
    exec(
      `npm version --allow-same-version=true --git-tag-version=false ${newVersion} `,
      deployDir
    );
    console.log("new version:", newVersion);
    registries.forEach((registry) =>
      exec("npm publish", {
        cwd: deployDir,
        env: { NPM_REGISTRY_URL: registry },
      })
    );
    exec(`git checkout package.json`); // cleanup
    github.git.createTag({
      owner,
      repo,
      newVersion,
      message: `automatic release of ${newVersion}`,
      commitish,
      type: "commit",
    });
    exec(`echo "::set-output name=version::${newVersion}"`); // set action event.{STEP_ID}.output.version
  };
  run();
} catch (error) {
  core.setFailed(error.message);
}
