const { resolve } = require('path');

const uniqBy = (array, property) => {
    const map = new Map();

    for (const element of array) {
        if (element && element.hasOwnProperty(property)) {
            map.set(element[property], element);
        }
    }

    return Array.from(map.values());
};

const removeDuplicateBackends = backendEnvironments =>
    uniqBy(backendEnvironments, 'url');

const fetchSampleBackends = async defaultSampleBackends => {
    try {
        const res = await fetch(
            'https://fvp0esmt8f.execute-api.us-east-1.amazonaws.com/default/getSampleBackends'
        );
        const { sampleBackends } = await res.json();

        return removeDuplicateBackends([
            ...sampleBackends.environments,
            ...defaultSampleBackends.environments
        ]).map(({ url }) => url);
    } catch {
        return defaultSampleBackends.environments.map(({ url }) => url);
    }
};

async function createProjectFromVenia({ fs, tasks, options, sampleBackends }) {
    const npmCli = options.npmClient;
    const sampleBackendEnvironments = await fetchSampleBackends(sampleBackends);

    const toCopyFromPackageJson = [
        'main',
        'browser',
        'dependencies',
        'devDependencies',
        'optionalDependencies',
        'engines',
        'pwa-studio'
    ];
    const scriptsToCopy = [
        'buildpack',
        'build',
        'build:analyze',
        'build:dev',
        'build:prod',
        'build:report',
        'clean',
        'download-schema',
        'lint',
        'prettier',
        'prettier:check',
        'prettier:fix',
        'start',
        'start:debug',
        'validate-queries',
        'watch'
    ];
    const scriptsToInsert = {
        storybook: 'start-storybook -p 9001 -c src/.storybook',
        'storybook:build': 'build-storybook -c src/.storybook -o storybook-dist'
    };

    const filesToIgnore = [
        'CHANGELOG*',
        'LICENSE*',
        '_buildpack',
        '_buildpack/**',
        // These tests are teporarily removed until we can implement a test
        // harness for the scaffolded app. See PWA-508.
        '**/__tests__',
        '**/__tests__/**'
    ];
    const ignoresGlob = `{${filesToIgnore.join(',')}}`;

    return {
        after({ options }) {
            // The venia-concept directory doesn't have its own babel.config.js
            // since that would interfere with monorepo configuration.
            // Therefore there is nothing to copy, so we use the "after" event
            // to write that file directly.
            fs.outputFileSync(
                resolve(options.directory, 'babel.config.js'),
                "module.exports = { presets: ['@magento/peregrine'] };\n",
                'utf8'
            );
        },
        visitor: {
            // Modify package.json with user details before copying it.
            'package.json': ({
                path,
                targetPath,
                options: { name, author, backendUrl }
            }) => {
                const pkgTpt = fs.readJsonSync(path);
                const pkg = {
                    name,
                    private: true,
                    version: '0.0.1',
                    description:
                        'A new project based on mgs-concept',
                    author,
                    license: 'UNLICENSED',
                    scripts: {}
                };
                toCopyFromPackageJson.forEach(prop => {
                    pkg[prop] = pkgTpt[prop];
                });

                // If the backend url is a sample backend, add the validator.
                if (sampleBackendEnvironments.includes(backendUrl)) {
                    pkg.devDependencies = {
                        ...pkg.devDependencies,
                        '@magento/venia-sample-backends': '~0.0.1'
                    };
                }

                // The mgs-concept template is part of the monorepo, which
                // uses yarn for workspaces. But if the user wants to use
                // npm, then the scripts which use `yarn` must change.
                const toPackageScript = script => {
                    const outputScript = script.replace(/\bmgs\b/g, name);
                    return npmCli === 'npm'
                        ? outputScript.replace(/yarn run/g, 'npm run')
                        : outputScript;
                };

                if (!pkgTpt.scripts) {
                    throw new Error(
                        JSON.stringify(pkgTpt, null, 2) +
                            '\ndoes not have a "scripts"'
                    );
                }
                scriptsToCopy.forEach(name => {
                    if (pkgTpt.scripts[name]) {
                        pkg.scripts[name] = toPackageScript(
                            pkgTpt.scripts[name]
                        );
                    }
                });
                Object.keys(scriptsToInsert).forEach(name => {
                    pkg.scripts[name] = toPackageScript(scriptsToInsert[name]);
                });

                if (process.env.DEBUG_PROJECT_CREATION) {
                    setDebugDependencies(pkg);
                }

                fs.outputJsonSync(targetPath, pkg, {
                    spaces: 2
                });
            },
            '.graphqlconfig': ({ path, targetPath, options: { name } }) => {
                const config = fs.readJsonSync(path);
                config.projects[name] = config.projects.mgs;
                delete config.projects.mgs;
                fs.outputJsonSync(targetPath, config, { spaces: 2 });
            },
            // These tasks are sequential so we must ignore before we copy.
            [ignoresGlob]: tasks.IGNORE,
            '**/*': tasks.COPY
        }
    };
}

function setDebugDependencies(pkg) {
    console.warn(
        'DEBUG_PROJECT_CREATION: Debugging Venia _buildpack/create.js, so we will assume we are inside the pwa-studio repo and replace those package dependency declarations with local file paths.'
    );

    const { execSync } = require('child_process');
    const overridden = {};
    const monorepoDir = resolve(__dirname, '../../../');

    // The Yarn "workspaces info" command outputs JSON as of v1.22.4.
    // The -s flag suppresses all other non-JSON logging output.
    const yarnWorkspaceInfoCmd = 'yarn -s workspaces info';
    const workspaceInfo = execSync(yarnWorkspaceInfoCmd, { cwd: monorepoDir });

    let packageDirs;
    try {
        // Build a list of package name => absolute package path tuples.
        packageDirs = Object.entries(JSON.parse(workspaceInfo)).map(
            ([name, info]) => [name, resolve(monorepoDir, info.location)]
        );
    } catch (e) {
        throw new Error(
            `DEBUG_PROJECT_CREATION: Could not parse output of '${yarnWorkspaceInfoCmd}:\n${workspaceInfo}. Please check your version of yarn is v1.22.4+.\n${
                e.stack
            }`
        );
    }

    // Venia does not depend on these packages.
    const packagesToSkip = new Set([
        '@magento/create-pwa',
        '@magento/upward-spec',
        // Venia especially does not depend on itself.
        'mgs-concept'
    ]);

    // We'll look for existing dependencies in all of the dep collections that
    // the package has.
    const depTypes = [
        'dependencies',
        'devDependencies',
        'optionalDependencies'
    ].filter(type => pkg.hasOwnProperty(type));

    // Modify the new project's package.json file to use our generated local
    // dependencies instead of going to the NPM registry and getting the old
    // versions of packages that haven't yet been released.
    for (const [name, packageDir] of packageDirs) {
        if (packagesToSkip.has(name)) {
            continue;
        }

        console.warn(`DEBUG_PROJECT_CREATION: Packing ${name} for local usage`);

        // We want to use local versions of these packages, which normally would
        // just be a `yarn link`. But symlinks and direct file URL pointers
        // aren't reliable in this case, because of the monorepo structure.
        // So instead, we use `npm pack` to make a tarball of each dependency,
        // which the scaffolded project will unzip and install.
        let filename;
        let packOutput;
        try {
            packOutput = execSync('npm pack -s --ignore-scripts --json', {
                cwd: packageDir
            })
                .toString('utf-8')
                .trim();
            // NPM tells you where it saved the tarball it made
            // modern versions just spit out the tarball name:
            if (packOutput.endsWith('.tgz')) {
                filename = packOutput;
            } else {
                filename = JSON.parse(packOutput)[0].filename;
            }
        } catch (e) {
            throw new Error(
                `DEBUG_PROJECT_CREATION: npm pack in ${name} package failed: output was ${packOutput}\n\nerror was ${
                    e.message
                }`
            );
        }

        // The `file://` URL scheme is legal in package.json.
        // https://docs.npmjs.com/files/package.json#urls-as-dependencies
        const localDep = `file://${resolve(packageDir, filename)}`;

        // All the local packages go in `overrides`, which we assign to
        // package.json `resolutions` a little bit under here.
        overridden[name] = localDep;

        // If the project has an explicit dependency on this package already...
        const depType =
            depTypes.find(type => pkg[type].hasOwnProperty(name)) ||
            // then depType will be the dependency collection where it was found.
            // This way we replace an existing dependency and avoid duplicates.
            // OR...
            // If not, then put it in the dependencies collection anyway.
            // That way, it can override any transitive dependencies that would
            // pull in the old version.
            'dependencies';

        pkg[depType][name] = localDep;
    }

    if (Object.keys(overridden).length > 0) {
        console.warn(
            'DEBUG_PROJECT_CREATION: Resolved the following packages via local tarball',
            JSON.stringify(overridden, null, 2)
        );

        // Force yarn to resolve all dependencies on these modules to the local
        // versions we just created:
        // https://classic.yarnpkg.com/en/docs/selective-version-resolutions/
        pkg.resolutions = Object.assign({}, pkg.resolutions, overridden);
    }
}

module.exports = createProjectFromVenia;
