/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import URI from 'vs/base/common/uri';
import Event, { Emitter } from 'vs/base/common/event';
import { normalize } from 'vs/base/common/paths';
import { delta } from 'vs/base/common/arrays';
import { relative, dirname } from 'path';
import { Workspace, WorkspaceFolder } from 'vs/platform/workspace/common/workspace';
import { IWorkspaceData, ExtHostWorkspaceShape, MainContext, MainThreadWorkspaceShape, IMainContext } from './extHost.protocol';
import * as vscode from 'vscode';
import { compare } from 'vs/base/common/strings';
import { TernarySearchTree } from 'vs/base/common/map';
import { basenameOrAuthority, isEqual } from 'vs/base/common/resources';
import { isLinux } from 'vs/base/common/platform';
import { onUnexpectedError } from 'vs/base/common/errors';

class Workspace2 extends Workspace {

	static fromData(data: IWorkspaceData) {
		if (!data) {
			return null;
		} else {
			const { id, name, folders } = data;
			return new Workspace2(
				id,
				name,
				folders.map(({ uri, name, index }) => new WorkspaceFolder({ name, index, uri: URI.revive(uri) }))
			);
		}
	}

	private _workspaceFolders: vscode.WorkspaceFolder[] = [];
	private readonly _structure = TernarySearchTree.forPaths<vscode.WorkspaceFolder>();

	private constructor(id: string, name: string, folders: WorkspaceFolder[]) {
		super(id, name, folders);

		// setup the workspace folder data structure
		this.folders.forEach(({ name, uri, index }) => {
			const workspaceFolder = { name, uri, index };
			this._workspaceFolders.push(workspaceFolder);
			this._structure.set(workspaceFolder.uri.toString(), workspaceFolder);
		});
	}

	get workspaceFolders(): vscode.WorkspaceFolder[] {
		return this._workspaceFolders.slice(0);
	}

	trySetWorkspaceFolders(folders: vscode.WorkspaceFolder[]): void {
		this._workspaceFolders = folders.map(({ uri, name, index }) => new WorkspaceFolder({ name, index, uri: URI.revive(uri) }));
	}

	getWorkspaceFolder(uri: URI, resolveParent?: boolean): vscode.WorkspaceFolder {
		if (resolveParent && this._structure.get(uri.toString())) {
			// `uri` is a workspace folder so we check for its parent
			uri = uri.with({ path: dirname(uri.path) });
		}
		return this._structure.findSubstr(uri.toString());
	}
}

export class ExtHostWorkspace implements ExtHostWorkspaceShape {

	private static _requestIdPool = 0;

	private readonly _onDidChangeWorkspace = new Emitter<vscode.WorkspaceFoldersChangeEvent>();
	private readonly _proxy: MainThreadWorkspaceShape;
	private _workspace: Workspace2;

	readonly onDidChangeWorkspace: Event<vscode.WorkspaceFoldersChangeEvent> = this._onDidChangeWorkspace.event;

	constructor(mainContext: IMainContext, data: IWorkspaceData) {
		this._proxy = mainContext.getProxy(MainContext.MainThreadWorkspace);
		this._workspace = Workspace2.fromData(data);
	}

	// --- workspace ---

	get workspace(): Workspace {
		return this._workspace;
	}

	getWorkspaceFolders(): vscode.WorkspaceFolder[] {
		if (!this._workspace) {
			return undefined;
		} else {
			return this._workspace.workspaceFolders.slice(0);
		}
	}

	updateWorkspaceFolders(extensionName: string, index: number, deleteCount: number, ...workspaceFoldersToAdd: { uri: vscode.Uri, name?: string }[]): boolean {
		const validatedDistinctWorkspaceFoldersToAdd: { uri: vscode.Uri, name?: string }[] = [];
		if (Array.isArray(workspaceFoldersToAdd)) {
			workspaceFoldersToAdd.forEach(folderToAdd => {
				if (URI.isUri(folderToAdd.uri) && !validatedDistinctWorkspaceFoldersToAdd.some(f => isEqual(f.uri, folderToAdd.uri, !isLinux))) {
					validatedDistinctWorkspaceFoldersToAdd.push(folderToAdd);
				}
			});
		}

		if ([index, deleteCount].some(i => typeof i !== 'number' || i < 0)) {
			return false; // validate numbers
		}

		if (deleteCount === 0 && validatedDistinctWorkspaceFoldersToAdd.length === 0) {
			return false; // nothing to delete or add
		}

		const currentWorkspaceFolders: vscode.WorkspaceFolder[] = this._workspace ? this._workspace.workspaceFolders : [];
		if (index + deleteCount > currentWorkspaceFolders.length) {
			return false; // cannot delete more than we have
		}

		const newWorkspaceFolders = currentWorkspaceFolders.slice(0);
		newWorkspaceFolders.splice(index, deleteCount, ...validatedDistinctWorkspaceFoldersToAdd.map((f, index) => ({ uri: f.uri, name: f.name || basenameOrAuthority(f.uri), index })));
		const { added, removed } = delta(currentWorkspaceFolders, newWorkspaceFolders, ExtHostWorkspace._compareWorkspaceFolderByUriAndName);
		if (added.length === 0 && removed.length === 0) {
			return false; // nothing actually changed
		}

		// Trigger on main side
		this._proxy.$updateWorkspaceFolders(extensionName, index, deleteCount, validatedDistinctWorkspaceFoldersToAdd).then(null, onUnexpectedError);

		// Update directly here
		if (this._workspace) {
			this._workspace.trySetWorkspaceFolders(newWorkspaceFolders);
		}

		return true;
	}

	getWorkspaceFolder(uri: vscode.Uri, resolveParent?: boolean): vscode.WorkspaceFolder {
		if (!this._workspace) {
			return undefined;
		}
		return this._workspace.getWorkspaceFolder(uri, resolveParent);
	}

	getPath(): string {
		// this is legacy from the days before having
		// multi-root and we keep it only alive if there
		// is just one workspace folder.
		if (!this._workspace) {
			return undefined;
		}
		const { folders } = this._workspace;
		if (folders.length === 0) {
			return undefined;
		}
		return folders[0].uri.fsPath;
	}

	getRelativePath(pathOrUri: string | vscode.Uri, includeWorkspace?: boolean): string {

		let path: string;
		if (typeof pathOrUri === 'string') {
			path = pathOrUri;
		} else if (typeof pathOrUri !== 'undefined') {
			path = pathOrUri.fsPath;
		}

		if (!path) {
			return path;
		}

		const folder = this.getWorkspaceFolder(
			typeof pathOrUri === 'string' ? URI.file(pathOrUri) : pathOrUri,
			true
		);

		if (!folder) {
			return path;
		}

		if (typeof includeWorkspace === 'undefined') {
			includeWorkspace = this.workspace.folders.length > 1;
		}

		let result = relative(folder.uri.fsPath, path);
		if (includeWorkspace) {
			result = `${folder.name}/${result}`;
		}
		return normalize(result, true);
	}

	$acceptWorkspaceData(data: IWorkspaceData): void {

		// keep old workspace folder, build new workspace, and
		// capture new workspace folders. Compute delta between
		// them send that as event
		const oldRoots = this._workspace ? this._workspace.workspaceFolders.sort(ExtHostWorkspace._compareWorkspaceFolderByUri) : [];

		this._workspace = Workspace2.fromData(data);
		const newRoots = this._workspace ? this._workspace.workspaceFolders.sort(ExtHostWorkspace._compareWorkspaceFolderByUri) : [];

		const { added, removed } = delta(oldRoots, newRoots, ExtHostWorkspace._compareWorkspaceFolderByUri);
		this._onDidChangeWorkspace.fire(Object.freeze({
			added: Object.freeze<vscode.WorkspaceFolder[]>(added),
			removed: Object.freeze<vscode.WorkspaceFolder[]>(removed)
		}));
	}

	private static _compareWorkspaceFolderByUri(a: vscode.WorkspaceFolder, b: vscode.WorkspaceFolder, includeName?: boolean): number {
		return compare(a.uri.toString(), b.uri.toString());
	}

	private static _compareWorkspaceFolderByUriAndName(a: vscode.WorkspaceFolder, b: vscode.WorkspaceFolder): number {
		return compare(a.uri.toString(), b.uri.toString()) + compare(a.name, b.name);
	}

	// --- search ---

	findFiles(include: vscode.GlobPattern, exclude: vscode.GlobPattern, maxResults?: number, token?: vscode.CancellationToken): Thenable<vscode.Uri[]> {
		const requestId = ExtHostWorkspace._requestIdPool++;

		let includePattern: string;
		let includeFolder: string;
		if (include) {
			if (typeof include === 'string') {
				includePattern = include;
			} else {
				includePattern = include.pattern;
				includeFolder = include.base;
			}
		}

		let excludePattern: string;
		if (exclude) {
			if (typeof exclude === 'string') {
				excludePattern = exclude;
			} else {
				excludePattern = exclude.pattern;
			}
		}

		const result = this._proxy.$startSearch(includePattern, includeFolder, excludePattern, maxResults, requestId);
		if (token) {
			token.onCancellationRequested(() => this._proxy.$cancelSearch(requestId));
		}
		return result.then(data => data.map(URI.revive));
	}

	saveAll(includeUntitled?: boolean): Thenable<boolean> {
		return this._proxy.$saveAll(includeUntitled);
	}
}
