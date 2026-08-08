import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const extensionsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const sharedDir = path.join(extensionsRoot, "_shared");

export function extensionDir(name) {
	return path.join(extensionsRoot, name);
}

export function resolvePiPackageDir(packageName) {
	const fromImport = resolvePackageDirFromImport(packageName);
	if (fromImport) return fromImport;

	const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
	const globalPackageDir = path.join(globalRoot, ...packageName.split("/"));
	if (fs.existsSync(path.join(globalPackageDir, "package.json"))) return globalPackageDir;

	throw new Error(`Unable to resolve ${packageName}`);
}

export function resolvePiTuiPackageDir() {
	const fromImport = resolvePackageDirFromImport("@earendil-works/pi-tui");
	if (fromImport) return fromImport;

	const bundled = path.join(
		resolvePiPackageDir("@earendil-works/pi-coding-agent"),
		"node_modules",
		"@earendil-works",
		"pi-tui",
	);
	if (fs.existsSync(path.join(bundled, "package.json"))) return bundled;

	throw new Error("Unable to resolve @earendil-works/pi-tui");
}

export async function copySharedFiles(targetDir, names) {
	await fs.promises.mkdir(targetDir, { recursive: true });
	for (const name of names) {
		await fs.promises.copyFile(path.join(sharedDir, name), path.join(targetDir, name));
	}
}

export async function linkPiPackages(targetExtensionDir, options = {}) {
	const scopeDir = path.join(targetExtensionDir, "node_modules", "@earendil-works");
	await fs.promises.mkdir(scopeDir, { recursive: true });
	await symlinkDir(resolvePiPackageDir("@earendil-works/pi-coding-agent"), path.join(scopeDir, "pi-coding-agent"));
	if (options.tui) {
		await symlinkDir(resolvePiTuiPackageDir(), path.join(scopeDir, "pi-tui"));
	}
}

export async function linkSharedPackages(targetExtensionDir) {
	const diffPackageDir = path.join(sharedDir, "node_modules", "diff");
	if (!fs.existsSync(path.join(diffPackageDir, "package.json"))) {
		throw new Error("Shared extension dependency diff is not installed; run npm install in extensions/_shared");
	}
	await fs.promises.mkdir(path.join(targetExtensionDir, "node_modules"), { recursive: true });
	await symlinkDir(diffPackageDir, path.join(targetExtensionDir, "node_modules", "diff"));
}

export function packageFileUrl(packageDir, relativePath) {
	return pathToFileURL(path.join(packageDir, relativePath)).href;
}

async function symlinkDir(target, linkPath) {
	await fs.promises.rm(linkPath, { force: true, recursive: true });
	await fs.promises.symlink(target, linkPath, "dir");
}

function resolvePackageDirFromImport(packageName) {
	try {
		return findPackageRoot(fileURLToPath(import.meta.resolve(packageName)));
	} catch {
		return undefined;
	}
}

function findPackageRoot(startPath) {
	let current = fs.statSync(startPath).isDirectory() ? startPath : path.dirname(startPath);
	while (true) {
		if (fs.existsSync(path.join(current, "package.json"))) return current;
		const parent = path.dirname(current);
		if (parent === current) throw new Error(`No package root for ${startPath}`);
		current = parent;
	}
}
