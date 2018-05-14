/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 *
 * @flow
 * @format
 */

import type {DeadlineRequest} from 'nuclide-commons/promise';
import type {
  AmendModeValue,
  BookmarkInfo,
  CheckoutOptions,
  HgRepositorySubscriptions,
  HgService,
  DiffInfo,
  LineDiff,
  OperationProgress,
  RevisionInfo,
  RevisionShowInfo,
  MergeConflicts,
  RevisionFileChanges,
  StatusCodeNumberValue,
  StatusCodeIdValue,
  VcsLogResponse,
  RevisionInfoFetched,
} from '../../nuclide-hg-rpc/lib/HgService';
import type {LegacyProcessMessage} from 'nuclide-commons/process';
import type {LRUCache} from 'lru-cache';
import type {ConnectableObservable} from 'rxjs';

import nuclideUri from 'nuclide-commons/nuclideUri';
import {timeoutAfterDeadline} from 'nuclide-commons/promise';
import {stringifyError} from 'nuclide-commons/string';
import {parseHgDiffUnifiedOutput} from '../../nuclide-hg-rpc/lib/hg-diff-output-parser';
import {Emitter} from 'atom';
import {
  cacheWhileSubscribed,
  fastDebounce,
  compact,
} from 'nuclide-commons/observable';
import RevisionsCache from './RevisionsCache';
import {gitDiffContentAgainstFile} from './utils';
import {
  StatusCodeIdToNumber,
  StatusCodeNumber,
} from '../../nuclide-hg-rpc/lib/hg-constants';
import {BehaviorSubject, Observable, Subject} from 'rxjs';
import LRU from 'lru-cache';
import featureConfig from 'nuclide-commons-atom/feature-config';
import observePaneItemVisibility from 'nuclide-commons-atom/observePaneItemVisibility';
import {observeBufferCloseOrRename} from '../../commons-atom/text-buffer';
import {getLogger} from 'log4js';
import nullthrows from 'nullthrows';

const STATUS_DEBOUNCE_DELAY_MS = 300;
const REVISION_DEBOUNCE_DELAY = 300;
const BOOKMARKS_DEBOUNCE_DELAY = 200;
const FETCH_BOOKMARKS_TIMEOUT = 15 * 1000;

export type RevisionStatusDisplay = {
  id: number,
  name: string,
  className: ?string,
  latestDiff: number, // id of the latest diff within this revision
  seriesLandBlocker?: string,
  seriesLandBlockerMessage?: string,
};

type HgRepositoryOptions = {
  /** The origin URL of this repository. */
  originURL: ?string,

  /** The working directory of this repository. */
  workingDirectory: atom$Directory | RemoteDirectory,

  /** The root directory that is opened in Atom, which this Repository serves. */
  projectRootDirectory?: atom$Directory,
};

/**
 *
 * Section: Constants, Type Definitions
 *
 */

const DID_CHANGE_CONFLICT_STATE = 'did-change-conflict-state';

export type RevisionStatuses = Map<number, RevisionStatusDisplay>;

type RevisionStatusCache = {
  getCachedRevisionStatuses(): Map<number, RevisionStatusDisplay>,
  observeRevisionStatusesChanges(): Observable<RevisionStatuses>,
  refresh(): void,
};

function getRevisionStatusCache(
  revisionsCache: RevisionsCache,
  workingDirectoryPath: string,
): RevisionStatusCache {
  try {
    // $FlowFB
    const FbRevisionStatusCache = require('./fb/RevisionStatusCache').default;
    return new FbRevisionStatusCache(revisionsCache, workingDirectoryPath);
  } catch (e) {
    return {
      getCachedRevisionStatuses() {
        return new Map();
      },
      observeRevisionStatusesChanges() {
        return Observable.empty();
      },
      refresh() {},
    };
  }
}

/**
 *
 * Section: HgRepositoryClient
 *
 */

/**
 * HgRepositoryClient runs on the machine that Nuclide/Atom is running on.
 * It is the interface that other Atom packages will use to access Mercurial.
 * It caches data fetched from an HgService.
 * It implements the same interface as GitRepository, (https://atom.io/docs/api/latest/GitRepository)
 * in addition to providing asynchronous methods for some getters.
 */

import type {NuclideUri} from 'nuclide-commons/nuclideUri';
import type {AdditionalLogFile} from '../../nuclide-logging/lib/rpc-types';
import type {RemoteDirectory} from '../../nuclide-remote-connection';

import UniversalDisposable from 'nuclide-commons/UniversalDisposable';
import {observableFromSubscribeFunction} from 'nuclide-commons/event';
import {mapTransform} from 'nuclide-commons/collection';

export type HgStatusChanges = {
  statusChanges: Observable<Map<NuclideUri, StatusCodeNumberValue>>,
  isCalculatingChanges: Observable<boolean>,
};

export class HgRepositoryClient {
  // An instance of HgRepositoryClient may be cloned to share the subscriptions
  // across multiple atom projects in the same hg repository, but allow
  // overriding of certain functionality depending on project root. To make sure
  // that changes to member vars are seen between all cloned instances, wrap
  // them in this object.
  // Not all properties need to be shared, but it was easier for the time-being
  // to do so. The only properties that TRULY need to be shared are those that
  // are assigned to from a cloned instance. A future refactor could possibly
  // better separate between those that are needed to be shared and those that
  // aren't. An even better--but more involved--future refactor could possibly
  // eliminate all instances of assigning to a member property from a cloned
  // instance in the first place.
  // Do not reassign this object.
  _sharedMembers: {
    rootRepo: HgRepositoryClient,
    path: string,
    workingDirectory: atom$Directory | RemoteDirectory,
    projectDirectory: ?atom$Directory,
    repoSubscriptions: Promise<?HgRepositorySubscriptions>,
    originURL: ?string,
    service: HgService,
    emitter: Emitter,
    subscriptions: UniversalDisposable,
    hgStatusCache: Map<NuclideUri, StatusCodeNumberValue>, // legacy, only for uncommitted
    hgUncommittedStatusChanges: HgStatusChanges,
    hgHeadStatusChanges: HgStatusChanges,
    hgStackStatusChanges: HgStatusChanges,
    hgDiffCache: Map<NuclideUri, DiffInfo>,
    hgDiffCacheFilesUpdating: Set<NuclideUri>,
    hgDiffCacheFilesToClear: Set<NuclideUri>,
    revisionsCache: RevisionsCache,
    revisionStatusCache: RevisionStatusCache,
    revisionIdToFileChanges: LRUCache<string, RevisionFileChanges>,
    fileContentsAtRevisionIds: LRUCache<string, Map<NuclideUri, string>>,
    fileContentsAtHead: LRUCache<NuclideUri, string>,
    currentHeadId: ?string,
    bookmarks: BehaviorSubject<{
      isLoading: boolean,
      bookmarks: Array<BookmarkInfo>,
    }>,

    isInConflict: boolean,
    isDestroyed: boolean,
    isFetchingPathStatuses: Subject<boolean>,
    manualStatusRefreshRequests: Subject<void>,
  };

  constructor(
    repoPath: string,
    hgService: HgService,
    options: HgRepositoryOptions,
  ) {
    // $FlowFixMe - by the end of the constructor, all the members should be initialized
    this._sharedMembers = {};

    this._sharedMembers.rootRepo = this;
    this._sharedMembers.path = repoPath;
    this._sharedMembers.workingDirectory = options.workingDirectory;
    this._sharedMembers.projectDirectory = options.projectRootDirectory;
    this._sharedMembers.originURL = options.originURL;
    this._sharedMembers.service = hgService;
    this._sharedMembers.isInConflict = false;
    this._sharedMembers.isDestroyed = false;
    this._sharedMembers.revisionsCache = new RevisionsCache(hgService);
    this._sharedMembers.revisionStatusCache = getRevisionStatusCache(
      this._sharedMembers.revisionsCache,
      this._sharedMembers.workingDirectory.getPath(),
    );
    this._sharedMembers.revisionIdToFileChanges = new LRU({max: 100});
    this._sharedMembers.fileContentsAtRevisionIds = new LRU({max: 20});
    this._sharedMembers.fileContentsAtHead = new LRU({max: 30});

    this._sharedMembers.emitter = new Emitter();
    this._sharedMembers.subscriptions = new UniversalDisposable(
      this._sharedMembers.emitter,
      this._sharedMembers.service,
    );
    this._sharedMembers.isFetchingPathStatuses = new Subject();
    this._sharedMembers.manualStatusRefreshRequests = new Subject();
    this._sharedMembers.hgStatusCache = new Map();
    this._sharedMembers.bookmarks = new BehaviorSubject({
      isLoading: true,
      bookmarks: [],
    });

    this._sharedMembers.hgDiffCache = new Map();
    this._sharedMembers.hgDiffCacheFilesUpdating = new Set();
    this._sharedMembers.hgDiffCacheFilesToClear = new Set();

    const diffStatsSubscription = (featureConfig.observeAsStream(
      'nuclide-hg-repository.enableDiffStats',
    ): Observable<any>)
      .switchMap((enableDiffStats: boolean) => {
        if (!enableDiffStats) {
          // TODO(most): rewrite fetching structures avoiding side effects
          this._sharedMembers.hgDiffCache = new Map();
          this._sharedMembers.emitter.emit('did-change-statuses');
          return Observable.empty();
        }

        return observableFromSubscribeFunction(
          atom.workspace.observeTextEditors.bind(atom.workspace),
        ).flatMap(textEditor => {
          return this._observePaneItemVisibility(textEditor).switchMap(
            visible => {
              if (!visible) {
                return Observable.empty();
              }

              const buffer = textEditor.getBuffer();
              const filePath = buffer.getPath();
              if (
                filePath == null ||
                filePath.length === 0 ||
                !this.isPathRelevantToRepository(filePath)
              ) {
                return Observable.empty();
              }
              return Observable.combineLatest(
                observableFromSubscribeFunction(
                  buffer.onDidSave.bind(buffer),
                ).startWith(''),
                this._sharedMembers.hgUncommittedStatusChanges.statusChanges,
              )
                .filter(([_, statusChanges]) => {
                  return (
                    statusChanges.has(filePath) &&
                    this.isStatusModified(statusChanges.get(filePath))
                  );
                })
                .map(() => filePath)
                .takeUntil(
                  Observable.merge(
                    observeBufferCloseOrRename(buffer),
                    this._observePaneItemVisibility(textEditor).filter(v => !v),
                  ).do(() => {
                    // TODO(most): rewrite to be simpler and avoid side effects.
                    // Remove the file from the diff stats cache when the buffer is closed.
                    this._sharedMembers.hgDiffCacheFilesToClear.add(filePath);
                  }),
                );
            },
          );
        });
      })
      .flatMap(filePath => this._updateDiffInfo([filePath]))
      .subscribe();
    this._sharedMembers.subscriptions.add(diffStatsSubscription);

    this._sharedMembers.repoSubscriptions = this._sharedMembers.service
      .createRepositorySubscriptions()
      .catch(error => {
        atom.notifications.addWarning(
          'Mercurial: failed to subscribe to watchman!',
        );
        getLogger('nuclide-hg-repository-client').error(
          `Failed to subscribe to watchman in ${this._sharedMembers.workingDirectory.getPath()}`,
          error,
        );
        return null;
      });
    const fileChanges = this._tryObserve(s =>
      s.observeFilesDidChange().refCount(),
    );
    const repoStateChanges = Observable.merge(
      this._tryObserve(s => s.observeHgRepoStateDidChange().refCount()),
      this._sharedMembers.manualStatusRefreshRequests,
    );
    const activeBookmarkChanges = this._tryObserve(s =>
      s.observeActiveBookmarkDidChange().refCount(),
    );
    const allBookmarkChanges = this._tryObserve(s =>
      s.observeBookmarksDidChange().refCount(),
    );
    const conflictStateChanges = this._tryObserve(s =>
      s.observeHgConflictStateDidChange().refCount(),
    );
    const commitChanges = this._tryObserve(s =>
      s.observeHgCommitsDidChange().refCount(),
    );

    this._sharedMembers.hgUncommittedStatusChanges = this._observeStatus(
      fileChanges,
      repoStateChanges,
      () => this._sharedMembers.service.fetchStatuses(),
    );

    this._sharedMembers.hgStackStatusChanges = this._observeStatus(
      fileChanges,
      repoStateChanges,
      () => this._sharedMembers.service.fetchStackStatuses(),
    );

    this._sharedMembers.hgHeadStatusChanges = this._observeStatus(
      fileChanges,
      repoStateChanges,
      () => this._sharedMembers.service.fetchHeadStatuses(),
    );

    const statusChangesSubscription = this._sharedMembers.hgUncommittedStatusChanges.statusChanges.subscribe(
      statuses => {
        this._sharedMembers.hgStatusCache = statuses;
        this._sharedMembers.emitter.emit('did-change-statuses');
      },
    );

    const shouldRevisionsUpdate = Observable.merge(
      this._sharedMembers.bookmarks.asObservable(),
      commitChanges,
      repoStateChanges,
    ).let(fastDebounce(REVISION_DEBOUNCE_DELAY));

    const bookmarksUpdates = Observable.merge(
      activeBookmarkChanges,
      allBookmarkChanges,
    )
      .startWith(null)
      .let(fastDebounce(BOOKMARKS_DEBOUNCE_DELAY))
      .switchMap(() =>
        Observable.defer(() => {
          return Observable.fromPromise(
            this._sharedMembers.service.fetchBookmarks(),
          ).timeout(FETCH_BOOKMARKS_TIMEOUT);
        })
          .retry(2)
          .catch(error => {
            getLogger('nuclide-hg-repository-client').error(
              'failed to fetch bookmarks info:',
              error,
            );
            return Observable.empty();
          }),
      );

    this._sharedMembers.subscriptions.add(
      statusChangesSubscription,
      bookmarksUpdates.subscribe(bookmarks =>
        this._sharedMembers.bookmarks.next({isLoading: false, bookmarks}),
      ),
      conflictStateChanges.subscribe(this._conflictStateChanged.bind(this)),
      shouldRevisionsUpdate.subscribe(() => {
        this._sharedMembers.revisionsCache.refreshRevisions();
        this._sharedMembers.fileContentsAtHead.reset();
        this._sharedMembers.hgDiffCache = new Map();
      }),
    );
  }

  // A single root HgRepositoryClient can back multiple HgRepositoryClients
  // via differential inheritance. This gets the 'original' HgRepositoryClient
  getRootRepoClient(): HgRepositoryClient {
    return this._sharedMembers.rootRepo;
  }

  // this._repoSubscriptions can potentially fail if Watchman fails.
  // The current behavior is to behave as if no changes ever occur.
  _tryObserve<T>(
    observe: (s: HgRepositorySubscriptions) => Observable<T>,
  ): Observable<T> {
    return Observable.fromPromise(
      this._sharedMembers.repoSubscriptions,
    ).switchMap(repoSubscriptions => {
      if (repoSubscriptions == null) {
        return Observable.never();
      }
      return observe(repoSubscriptions);
    });
  }

  async getAdditionalLogFiles(
    deadline: DeadlineRequest,
  ): Promise<Array<AdditionalLogFile>> {
    const path = this._sharedMembers.workingDirectory.getPath();
    const prefix = nuclideUri.isRemote(path)
      ? `${nuclideUri.getHostname(path)}:`
      : '';
    const results = await timeoutAfterDeadline(
      deadline,
      this._sharedMembers.service.getAdditionalLogFiles(deadline - 1000),
    ).catch(e => [{title: `${path}:hg`, data: stringifyError(e)}]);
    return results.map(log => ({...log, title: prefix + log.title}));
  }

  _observeStatus(
    fileChanges: Observable<Array<string>>,
    repoStateChanges: Observable<void>,
    fetchStatuses: () => ConnectableObservable<
      Map<NuclideUri, StatusCodeIdValue>,
    >,
  ): HgStatusChanges {
    const triggers = Observable.merge(fileChanges, repoStateChanges)
      .let(fastDebounce(STATUS_DEBOUNCE_DELAY_MS))
      .share()
      .startWith(null);
    // Share comes before startWith. That's because fileChanges/repoStateChanges
    // are already hot and can be shared fine. But we want both our subscribers,
    // statusChanges and isCalculatingChanges, to pick up their own copy of
    // startWith(null) no matter which order they subscribe.

    const statusChanges = cacheWhileSubscribed(
      triggers
        .switchMap(() => {
          this._sharedMembers.isFetchingPathStatuses.next(true);
          return fetchStatuses()
            .refCount()
            .catch(error => {
              getLogger('nuclide-hg-repository-client').error(
                'HgService cannot fetch statuses',
                error,
              );
              return Observable.empty();
            })
            .finally(() => {
              this._sharedMembers.isFetchingPathStatuses.next(false);
            });
        })
        .map(uriToStatusIds =>
          mapTransform(uriToStatusIds, (v, k) => StatusCodeIdToNumber[v]),
        ),
    );

    const isCalculatingChanges = cacheWhileSubscribed(
      Observable.merge(
        triggers.map(_ => true),
        statusChanges.map(_ => false),
      ).distinctUntilChanged(),
    );

    return {statusChanges, isCalculatingChanges};
  }

  destroy() {
    if (this._sharedMembers.isDestroyed) {
      return;
    }
    this._sharedMembers.isDestroyed = true;
    this._sharedMembers.emitter.emit('did-destroy');
    this._sharedMembers.subscriptions.dispose();
    this._sharedMembers.revisionIdToFileChanges.reset();
    this._sharedMembers.fileContentsAtRevisionIds.reset();
    this._sharedMembers.repoSubscriptions.then(repoSubscriptions => {
      if (repoSubscriptions != null) {
        repoSubscriptions.dispose();
      }
    });
  }

  isDestroyed(): boolean {
    return this._sharedMembers.isDestroyed;
  }

  _conflictStateChanged(isInConflict: boolean): void {
    this._sharedMembers.isInConflict = isInConflict;
    this._sharedMembers.emitter.emit(DID_CHANGE_CONFLICT_STATE);
  }

  /**
   *
   * Section: Event Subscription
   *
   */

  onDidDestroy(callback: () => mixed): IDisposable {
    return this._sharedMembers.emitter.on('did-destroy', callback);
  }

  onDidChangeStatus(
    callback: (event: {
      path: string,
      pathStatus: StatusCodeNumberValue,
    }) => mixed,
  ): IDisposable {
    return this._sharedMembers.emitter.on('did-change-status', callback);
  }

  observeBookmarks(): Observable<Array<BookmarkInfo>> {
    return this._sharedMembers.bookmarks
      .asObservable()
      .filter(b => !b.isLoading)
      .map(b => b.bookmarks);
  }

  observeRevisionChanges(): Observable<RevisionInfoFetched> {
    return this._sharedMembers.revisionsCache.observeRevisionChanges();
  }

  observeIsFetchingRevisions(): Observable<boolean> {
    return this._sharedMembers.revisionsCache.observeIsFetchingRevisions();
  }

  observeIsFetchingPathStatuses(): Observable<boolean> {
    return this._sharedMembers.isFetchingPathStatuses.asObservable();
  }

  observeRevisionStatusesChanges(): Observable<RevisionStatuses> {
    return this._sharedMembers.revisionStatusCache.observeRevisionStatusesChanges();
  }

  observeUncommittedStatusChanges(): HgStatusChanges {
    return this._sharedMembers.hgUncommittedStatusChanges;
  }

  observeHeadStatusChanges(): HgStatusChanges {
    return this._sharedMembers.hgHeadStatusChanges;
  }

  observeStackStatusChanges(): HgStatusChanges {
    return this._sharedMembers.hgStackStatusChanges;
  }

  _observePaneItemVisibility(item: Object): Observable<boolean> {
    return observePaneItemVisibility(item);
  }

  observeOperationProgressChanges(): Observable<OperationProgress> {
    return this._tryObserve(s =>
      s.observeHgOperationProgressDidChange().refCount(),
    );
  }

  onDidChangeStatuses(callback: () => mixed): IDisposable {
    return this._sharedMembers.emitter.on('did-change-statuses', callback);
  }

  onDidChangeConflictState(callback: () => mixed): IDisposable {
    return this._sharedMembers.emitter.on(DID_CHANGE_CONFLICT_STATE, callback);
  }

  observeLockFiles(): Observable<Map<string, boolean>> {
    return this._tryObserve(s => s.observeLockFilesDidChange().refCount());
  }

  observeHeadRevision(): Observable<RevisionInfo> {
    return this.observeRevisionChanges()
      .map(revisionInfoFetched =>
        revisionInfoFetched.revisions.find(revision => revision.isHead),
      )
      .let(compact)
      .distinctUntilChanged(
        (prevRev, nextRev) => prevRev.hash === nextRev.hash,
      );
  }

  /**
   *
   * Section: Repository Details
   *
   */

  getType(): string {
    return 'hg';
  }

  getPath(): string {
    return this._sharedMembers.path;
  }

  getWorkingDirectory(): string {
    return this._sharedMembers.workingDirectory.getPath();
  }

  // @return The path of the root project folder in Atom that this
  // HgRepositoryClient provides information about.
  getProjectDirectory(): string {
    return this.getInternalProjectDirectory().getPath();
  }

  // This function exists to be shadowed
  getInternalProjectDirectory(): atom$Directory {
    return nullthrows(this._sharedMembers.projectDirectory);
  }

  // TODO This is a stub.
  isProjectAtRoot(): boolean {
    return true;
  }

  relativize(filePath: NuclideUri): string {
    return this._sharedMembers.workingDirectory.relativize(filePath);
  }

  // TODO This is a stub.
  hasBranch(branch: string): boolean {
    return false;
  }

  /**
   * @return The current Hg bookmark.
   */
  getShortHead(filePath?: NuclideUri): string {
    return (
      this._sharedMembers.bookmarks
        .getValue()
        .bookmarks.filter(bookmark => bookmark.active)
        .map(bookmark => bookmark.bookmark)[0] || ''
    );
  }

  // TODO This is a stub.
  isSubmodule(path: NuclideUri): boolean {
    return false;
  }

  // TODO This is a stub.
  getAheadBehindCount(reference: string, path: NuclideUri): number {
    return 0;
  }

  // TODO This is a stub.
  getCachedUpstreamAheadBehindCount(
    path: ?NuclideUri,
  ): {ahead: number, behind: number} {
    return {
      ahead: 0,
      behind: 0,
    };
  }

  // TODO This is a stub.
  getConfigValue(key: string, path: ?string): ?string {
    return null;
  }

  getOriginURL(path: ?string): ?string {
    return this._sharedMembers.originURL;
  }

  // TODO This is a stub.
  getUpstreamBranch(path: ?string): ?string {
    return null;
  }

  // TODO This is a stub.
  getReferences(
    path: ?NuclideUri,
  ): {heads: Array<string>, remotes: Array<string>, tags: Array<string>} {
    return {
      heads: [],
      remotes: [],
      tags: [],
    };
  }

  // TODO This is a stub.
  getReferenceTarget(reference: string, path: ?NuclideUri): ?string {
    return null;
  }

  // Added for conflict detection.
  isInConflict(): boolean {
    return this._sharedMembers.isInConflict;
  }

  /**
   *
   * Section: Reading Status (parity with GitRepository)
   *
   */

  // TODO (jessicalin) Can we change the API to make this method return a Promise?
  // If not, might need to do a synchronous `hg status` query.
  isPathModified(filePath: ?NuclideUri): boolean {
    // flowlint-next-line sketchy-null-string:off
    if (!filePath) {
      return false;
    }
    const cachedPathStatus = this._sharedMembers.hgStatusCache.get(filePath);
    if (!cachedPathStatus) {
      return false;
    } else {
      return this.isStatusModified(cachedPathStatus);
    }
  }

  // TODO (jessicalin) Can we change the API to make this method return a Promise?
  // If not, might need to do a synchronous `hg status` query.
  isPathNew(filePath: ?NuclideUri): boolean {
    // flowlint-next-line sketchy-null-string:off
    if (!filePath) {
      return false;
    }
    const cachedPathStatus = this._sharedMembers.hgStatusCache.get(filePath);
    if (!cachedPathStatus) {
      return false;
    } else {
      return this.isStatusNew(cachedPathStatus);
    }
  }

  isPathAdded(filePath: ?NuclideUri): boolean {
    // flowlint-next-line sketchy-null-string:off
    if (!filePath) {
      return false;
    }
    const cachedPathStatus = this._sharedMembers.hgStatusCache.get(filePath);
    if (!cachedPathStatus) {
      return false;
    } else {
      return this.isStatusAdded(cachedPathStatus);
    }
  }

  isPathUntracked(filePath: ?NuclideUri): boolean {
    // flowlint-next-line sketchy-null-string:off
    if (!filePath) {
      return false;
    }
    const cachedPathStatus = this._sharedMembers.hgStatusCache.get(filePath);
    if (!cachedPathStatus) {
      return false;
    } else {
      return this.isStatusUntracked(cachedPathStatus);
    }
  }

  // TODO (jessicalin) Can we change the API to make this method return a Promise?
  // If not, this method lies a bit by using cached information.
  // TODO (jessicalin) Make this work for ignored directories.
  isPathIgnored(filePath: ?NuclideUri): boolean {
    // flowlint-next-line sketchy-null-string:off
    if (!filePath) {
      return false;
    }
    // `hg status -i` does not list the repo (the .hg directory), presumably
    // because the repo does not track itself.
    // We want to represent the fact that it's not part of the tracked contents,
    // so we manually add an exception for it via the _isPathWithinHgRepo check.
    const cachedPathStatus = this._sharedMembers.hgStatusCache.get(filePath);
    if (!cachedPathStatus) {
      return this._isPathWithinHgRepo(filePath);
    } else {
      return this.isStatusIgnored(cachedPathStatus);
    }
  }

  /**
   * Checks if the given path is within the repo directory (i.e. `.hg/`).
   */
  _isPathWithinHgRepo(filePath: NuclideUri): boolean {
    return (
      filePath === this.getPath() ||
      filePath.indexOf(this.getPath() + '/') === 0
    );
  }

  /**
   * Checks whether a path is relevant to this HgRepositoryClient. A path is
   * defined as 'relevant' if it is within the project directory opened within the repo.
   */
  isPathRelevant(filePath: NuclideUri): boolean {
    return (
      this.getInternalProjectDirectory().contains(filePath) ||
      this.getInternalProjectDirectory().getPath() === filePath
    );
  }

  isPathRelevantToRepository(filePath: NuclideUri): boolean {
    return (
      this._sharedMembers.workingDirectory.contains(filePath) ||
      this._sharedMembers.workingDirectory.getPath() === filePath
    );
  }

  // non-used stub.
  getDirectoryStatus(directoryPath: ?string): StatusCodeNumberValue {
    return StatusCodeNumber.CLEAN;
  }

  // We don't want to do any synchronous 'hg status' calls. Just use cached values.
  getPathStatus(filePath: NuclideUri): StatusCodeNumberValue {
    return this.getCachedPathStatus(filePath);
  }

  getCachedPathStatus(filePath: ?NuclideUri): StatusCodeNumberValue {
    // flowlint-next-line sketchy-null-string:off
    if (!filePath) {
      return StatusCodeNumber.CLEAN;
    }
    const cachedStatus = this._sharedMembers.hgStatusCache.get(filePath);
    if (cachedStatus) {
      return cachedStatus;
    }
    return StatusCodeNumber.CLEAN;
  }

  // getAllPathStatuses -- this legacy API gets only uncommitted statuses
  getAllPathStatuses(): {[filePath: NuclideUri]: StatusCodeNumberValue} {
    const pathStatuses = Object.create(null);
    for (const [filePath, status] of this._sharedMembers.hgStatusCache) {
      pathStatuses[filePath] = status;
    }
    // $FlowFixMe(>=0.55.0) Flow suppress
    return pathStatuses;
  }

  isStatusModified(status: ?number): boolean {
    return status === StatusCodeNumber.MODIFIED;
  }

  isStatusDeleted(status: ?number): boolean {
    return (
      status === StatusCodeNumber.MISSING || status === StatusCodeNumber.REMOVED
    );
  }

  isStatusNew(status: ?number): boolean {
    return (
      status === StatusCodeNumber.ADDED || status === StatusCodeNumber.UNTRACKED
    );
  }

  isStatusAdded(status: ?number): boolean {
    return status === StatusCodeNumber.ADDED;
  }

  isStatusUntracked(status: ?number): boolean {
    return status === StatusCodeNumber.UNTRACKED;
  }

  isStatusIgnored(status: ?number): boolean {
    return status === StatusCodeNumber.IGNORED;
  }

  /**
   *
   * Section: Retrieving Diffs (parity with GitRepository)
   *
   */

  getDiffStats(filePath: ?NuclideUri): {added: number, deleted: number} {
    const cleanStats = {added: 0, deleted: 0};
    // flowlint-next-line sketchy-null-string:off
    if (!filePath) {
      return cleanStats;
    }
    const cachedData = this._sharedMembers.hgDiffCache.get(filePath);
    return cachedData
      ? {added: cachedData.added, deleted: cachedData.deleted}
      : cleanStats;
  }

  /**
   * Returns an array of LineDiff that describes the diffs between the given
   * file's `HEAD` contents and its current contents.
   * NOTE: this method currently ignores the passed-in text, and instead diffs
   * against the currently saved contents of the file.
   */
  // TODO (jessicalin) Export the LineDiff type (from hg-output-helpers) when
  // types can be exported.
  // TODO (jessicalin) Make this method work with the passed-in `text`. t6391579
  getLineDiffs(filePath: ?NuclideUri, text: ?string): Array<LineDiff> {
    // flowlint-next-line sketchy-null-string:off
    if (!filePath) {
      return [];
    }
    const diffInfo = this._sharedMembers.hgDiffCache.get(filePath);
    return diffInfo ? diffInfo.lineDiffs : [];
  }

  /**
   *
   * Section: Retrieving Diffs (async methods)
   *
   */

  /**
   * Updates the diff information for the given paths, and updates the cache.
   * @param An array of absolute file paths for which to update the diff info.
   * @return A map of each path to its DiffInfo.
   *   This method may return `null` if the call to `hg diff` fails.
   *   A file path will not appear in the returned Map if it is not in the repo,
   *   if it has no changes, or if there is a pending `hg diff` call for it already.
   */
  _updateDiffInfo(
    filePaths: Array<NuclideUri>,
  ): Observable<?Map<NuclideUri, DiffInfo>> {
    const pathsToFetch = filePaths.filter(aPath => {
      // Don't try to fetch information for this path if it's not in the repo.
      if (!this.isPathRelevantToRepository(aPath)) {
        return false;
      }
      // Don't do another update for this path if we are in the middle of running an update.
      if (this._sharedMembers.hgDiffCacheFilesUpdating.has(aPath)) {
        return false;
      } else {
        this._sharedMembers.hgDiffCacheFilesUpdating.add(aPath);
        return true;
      }
    });

    if (pathsToFetch.length === 0) {
      return Observable.of(new Map());
    }

    return this._getCurrentHeadId().switchMap(currentHeadId => {
      if (currentHeadId == null) {
        return Observable.of(new Map());
      }

      return this._getFileDiffs(pathsToFetch, currentHeadId).do(
        pathsToDiffInfo => {
          if (pathsToDiffInfo) {
            for (const [filePath, diffInfo] of pathsToDiffInfo) {
              this._sharedMembers.hgDiffCache.set(filePath, diffInfo);
            }
          }

          // Remove files marked for deletion.
          this._sharedMembers.hgDiffCacheFilesToClear.forEach(fileToClear => {
            this._sharedMembers.hgDiffCache.delete(fileToClear);
          });
          this._sharedMembers.hgDiffCacheFilesToClear.clear();

          // The fetched files can now be updated again.
          for (const pathToFetch of pathsToFetch) {
            this._sharedMembers.hgDiffCacheFilesUpdating.delete(pathToFetch);
          }

          // TODO (t9113913) Ideally, we could send more targeted events that better
          // describe what change has occurred. Right now, GitRepository dictates either
          // 'did-change-status' or 'did-change-statuses'.
          this._sharedMembers.emitter.emit('did-change-statuses');
        },
      );
    });
  }

  _getFileDiffs(
    pathsToFetch: Array<NuclideUri>,
    revision: string,
  ): Observable<Map<NuclideUri, DiffInfo>> {
    const fileContents = pathsToFetch.map(filePath => {
      const cachedContent = this._sharedMembers.fileContentsAtHead.get(
        filePath,
      );
      let contentObservable;
      if (cachedContent == null) {
        contentObservable = this._sharedMembers.service
          .fetchFileContentAtRevision(filePath, revision)
          .refCount()
          .map(contents => {
            this._sharedMembers.fileContentsAtHead.set(filePath, contents);
            return contents;
          });
      } else {
        contentObservable = Observable.of(cachedContent);
      }
      return contentObservable
        .switchMap(content => {
          return gitDiffContentAgainstFile(content, filePath);
        })
        .map(diff => ({
          filePath,
          diff,
        }));
    });
    const diffs = Observable.merge(...fileContents)
      .map(({filePath, diff}) => {
        // This is to differentiate between diff delimiter and the source
        // eslint-disable-next-line no-useless-escape
        const toParse = diff.split('--- ');
        const lineDiff = parseHgDiffUnifiedOutput(toParse[1]);
        return [filePath, lineDiff];
      })
      .toArray()
      .map(contents => new Map(contents));
    return diffs;
  }

  _getCurrentHeadId(): Observable<string> {
    if (this._sharedMembers.currentHeadId != null) {
      return Observable.of(this._sharedMembers.currentHeadId);
    }
    return this._sharedMembers.service
      .getHeadId()
      .refCount()
      .do(headId => (this._sharedMembers.currentHeadId = headId));
  }

  fetchMergeConflicts(): Observable<?MergeConflicts> {
    return this._sharedMembers.service.fetchMergeConflicts().refCount();
  }

  markConflictedFile(
    filePath: NuclideUri,
    resolved: boolean,
  ): Observable<LegacyProcessMessage> {
    // TODO(T17463635)
    return this._sharedMembers.service
      .markConflictedFile(filePath, resolved)
      .refCount();
  }

  /**
   *
   * Section: Checking Out
   *
   */

  /**
   * That extends the `GitRepository` implementation which takes a single file path.
   * Here, it's possible to pass an array of file paths to revert/checkout-head.
   */
  checkoutHead(filePathsArg: NuclideUri | Array<NuclideUri>): Promise<void> {
    const filePaths = Array.isArray(filePathsArg)
      ? filePathsArg
      : [filePathsArg];
    return this._sharedMembers.service.revert(filePaths);
  }

  checkoutReference(
    reference: string,
    create: boolean,
    options?: CheckoutOptions,
  ): Observable<LegacyProcessMessage> {
    // TODO(T17463635)
    return this._sharedMembers.service
      .checkout(reference, create, options)
      .refCount();
  }

  show(revision: number): Observable<RevisionShowInfo> {
    return this._sharedMembers.service.show(revision).refCount();
  }

  diff(
    revision: number | string,
    options: {
      // diffCommitted uses the -c flag instead of -r, fetches committed changes
      // '--unified n' gives us n lines of context around the change
      // '--noprefix' omits the a/ and b/ prefixes from filenames
      // '--nodates' avoids appending dates to the file path line
      unified?: number,
      diffCommitted?: boolean,
      noPrefix?: boolean,
      noDates?: boolean,
    } = {},
  ): Observable<string> {
    const {unified, diffCommitted, noPrefix, noDates} = options;
    return this._sharedMembers.service
      .diff(String(revision), unified, diffCommitted, noPrefix, noDates)
      .refCount();
  }

  purge(): Promise<void> {
    return this._sharedMembers.service.purge();
  }

  stripReference(reference: string): Promise<void> {
    return this._sharedMembers.service.strip(reference);
  }

  uncommit(): Promise<void> {
    return this._sharedMembers.service.uncommit();
  }

  checkoutForkBase(): Promise<void> {
    return this._sharedMembers.service.checkoutForkBase();
  }

  /**
   *
   * Section: Bookmarks
   *
   */
  createBookmark(name: string, revision: ?string): Promise<void> {
    return this._sharedMembers.service.createBookmark(name, revision);
  }

  deleteBookmark(name: string): Promise<void> {
    return this._sharedMembers.service.deleteBookmark(name);
  }

  renameBookmark(name: string, nextName: string): Promise<void> {
    return this._sharedMembers.service.renameBookmark(name, nextName);
  }

  /**
   *
   * Section: HgService subscriptions
   *
   */

  /**
   *
   * Section: Repository State at Specific Revisions
   *
   */
  fetchFileContentAtRevision(
    filePath: NuclideUri,
    revision: string,
  ): Observable<string> {
    let fileContentsAtRevision = this._sharedMembers.fileContentsAtRevisionIds.get(
      revision,
    );
    if (fileContentsAtRevision == null) {
      fileContentsAtRevision = new Map();
      this._sharedMembers.fileContentsAtRevisionIds.set(
        revision,
        fileContentsAtRevision,
      );
    }
    const committedContents = fileContentsAtRevision.get(filePath);
    if (committedContents != null) {
      return Observable.of(committedContents);
    } else {
      return this._sharedMembers.service
        .fetchFileContentAtRevision(filePath, revision)
        .refCount()
        .do(contents => fileContentsAtRevision.set(filePath, contents));
    }
  }

  fetchFilesChangedAtRevision(
    revision: string,
  ): Observable<RevisionFileChanges> {
    const changes = this._sharedMembers.revisionIdToFileChanges.get(revision);
    if (changes != null) {
      return Observable.of(changes);
    } else {
      return this._sharedMembers.service
        .fetchFilesChangedAtRevision(revision)
        .refCount()
        .do(fetchedChanges =>
          this._sharedMembers.revisionIdToFileChanges.set(
            revision,
            fetchedChanges,
          ),
        );
    }
  }

  fetchFilesChangedSinceRevision(
    revision: string,
  ): Observable<Map<NuclideUri, StatusCodeNumberValue>> {
    return this._sharedMembers.service
      .fetchStatuses(revision)
      .refCount()
      .map(fileStatuses => {
        const statusesWithCodeIds = new Map();
        for (const [filePath, code] of fileStatuses) {
          statusesWithCodeIds.set(filePath, StatusCodeIdToNumber[code]);
        }
        return statusesWithCodeIds;
      });
  }

  fetchRevisionInfoBetweenHeadAndBase(): Promise<Array<RevisionInfo>> {
    return this._sharedMembers.service.fetchRevisionInfoBetweenHeadAndBase();
  }

  fetchSmartlogRevisions(): Observable<Array<RevisionInfo>> {
    return this._sharedMembers.service.fetchSmartlogRevisions().refCount();
  }

  refreshRevisions(): void {
    this._sharedMembers.revisionsCache.refreshRevisions();
  }

  refreshRevisionsStatuses(): void {
    this._sharedMembers.revisionStatusCache.refresh();
  }

  getCachedRevisions(): Array<RevisionInfo> {
    return this._sharedMembers.revisionsCache.getCachedRevisions().revisions;
  }

  getCachedRevisionStatuses(): RevisionStatuses {
    return this._sharedMembers.revisionStatusCache.getCachedRevisionStatuses();
  }

  // See HgService.getBaseRevision.
  getBaseRevision(): Promise<RevisionInfo> {
    return this._sharedMembers.service.getBaseRevision();
  }

  // See HgService.getBlameAtHead.
  getBlameAtHead(filePath: NuclideUri): Promise<Array<?RevisionInfo>> {
    return this._sharedMembers.service.getBlameAtHead(filePath);
  }

  getTemplateCommitMessage(): Promise<?string> {
    return this._sharedMembers.service.getTemplateCommitMessage();
  }

  getHeadCommitMessage(): Promise<?string> {
    return this._sharedMembers.service.getHeadCommitMessage();
  }

  /**
   * Return relative paths to status code number values object.
   * matching `GitRepositoryAsync` implementation.
   */
  getCachedPathStatuses(): {[filePath: string]: StatusCodeNumberValue} {
    const absoluteCodePaths = this.getAllPathStatuses();
    const relativeCodePaths = {};
    for (const absolutePath in absoluteCodePaths) {
      const relativePath = this.relativize(absolutePath);
      relativeCodePaths[relativePath] = absoluteCodePaths[absolutePath];
    }
    return relativeCodePaths;
  }

  getConfigValueAsync(key: string, path: ?string): Promise<?string> {
    return this._sharedMembers.service.getConfigValueAsync(key);
  }

  // See HgService.getDifferentialRevisionForChangeSetId.
  getDifferentialRevisionForChangeSetId(changeSetId: string): Promise<?string> {
    return this._sharedMembers.service.getDifferentialRevisionForChangeSetId(
      changeSetId,
    );
  }

  getSmartlog(ttyOutput: boolean, concise: boolean): Promise<Object> {
    return this._sharedMembers.service.getSmartlog(ttyOutput, concise);
  }

  copy(
    filePaths: Array<NuclideUri>,
    destPath: NuclideUri,
    after: boolean = false,
  ): Promise<void> {
    return this._sharedMembers.service.copy(filePaths, destPath, after);
  }

  rename(
    filePaths: Array<NuclideUri>,
    destPath: NuclideUri,
    after: boolean = false,
  ): Promise<void> {
    return this._sharedMembers.service.rename(filePaths, destPath, after);
  }

  remove(filePaths: Array<NuclideUri>, after: boolean = false): Promise<void> {
    return this._sharedMembers.service.remove(filePaths, after);
  }

  forget(filePaths: Array<NuclideUri>): Promise<void> {
    return this._sharedMembers.service.forget(filePaths);
  }

  addAll(filePaths: Array<NuclideUri>): Promise<void> {
    return this._sharedMembers.service.add(filePaths);
  }

  commit(
    message: string,
    filePaths: Array<NuclideUri> = [],
  ): Observable<LegacyProcessMessage> {
    // TODO(T17463635)
    return this._sharedMembers.service
      .commit(message, filePaths)
      .refCount()
      .do(processMessage =>
        this._clearOnSuccessExit(processMessage, filePaths),
      );
  }

  amend(
    message: ?string,
    amendMode: AmendModeValue,
    filePaths: Array<NuclideUri> = [],
  ): Observable<LegacyProcessMessage> {
    // TODO(T17463635)
    return this._sharedMembers.service
      .amend(message, amendMode, filePaths)
      .refCount()
      .do(processMessage =>
        this._clearOnSuccessExit(processMessage, filePaths),
      );
  }

  restack(): Observable<LegacyProcessMessage> {
    return this._sharedMembers.service.restack().refCount();
  }

  editCommitMessage(
    revision: string,
    message: string,
  ): Observable<LegacyProcessMessage> {
    return this._sharedMembers.service
      .editCommitMessage(revision, message)
      .refCount();
  }

  _clearOnSuccessExit(
    message: LegacyProcessMessage,
    filePaths: Array<NuclideUri>,
  ) {
    if (message.kind === 'exit' && message.exitCode === 0) {
      this._clearClientCache(filePaths);
    }
  }

  revert(filePaths: Array<NuclideUri>, toRevision?: ?string): Promise<void> {
    return this._sharedMembers.service.revert(filePaths, toRevision);
  }

  log(filePaths: Array<NuclideUri>, limit?: ?number): Promise<VcsLogResponse> {
    // TODO(mbolin): Return an Observable so that results appear faster.
    // Unfortunately, `hg log -Tjson` is not Observable-friendly because it will
    // not parse as JSON until all of the data has been printed to stdout.
    return this._sharedMembers.service.log(filePaths, limit);
  }

  getFullHashForRevision(rev: string): Promise<?string> {
    return this._sharedMembers.service.getFullHashForRevision(rev);
  }

  continueOperation(
    commandWithOptions: Array<string>,
  ): Observable<LegacyProcessMessage> {
    // TODO(T17463635)
    return this._sharedMembers.service
      .continueOperation(commandWithOptions)
      .refCount();
  }

  abortOperation(commandWithOptions: Array<string>): Observable<string> {
    return this._sharedMembers.service
      .abortOperation(commandWithOptions)
      .refCount();
  }

  resolveAllFiles(): Observable<LegacyProcessMessage> {
    return this._sharedMembers.service.resolveAllFiles().refCount();
  }

  rebase(
    destination: string,
    source?: string,
  ): Observable<LegacyProcessMessage> {
    // TODO(T17463635)
    return this._sharedMembers.service.rebase(destination, source).refCount();
  }

  reorderWithinStack(orderedRevisions: Array<string>): Observable<string> {
    return this._sharedMembers.service
      .reorderWithinStack(orderedRevisions)
      .refCount();
  }

  pull(options?: Array<string> = []): Observable<LegacyProcessMessage> {
    // TODO(T17463635)
    return this._sharedMembers.service.pull(options).refCount();
  }

  fold(from: string, to: string, message: string): Observable<string> {
    return this._sharedMembers.service.fold(from, to, message).refCount();
  }

  _clearClientCache(filePaths: Array<NuclideUri>): void {
    if (filePaths.length === 0) {
      this._sharedMembers.hgDiffCache = new Map();
      this._sharedMembers.hgStatusCache = new Map();
      this._sharedMembers.fileContentsAtHead.reset();
    } else {
      this._sharedMembers.hgDiffCache = new Map(
        this._sharedMembers.hgDiffCache,
      );
      this._sharedMembers.hgStatusCache = new Map(
        this._sharedMembers.hgStatusCache,
      );
      filePaths.forEach(filePath => {
        this._sharedMembers.hgDiffCache.delete(filePath);
        this._sharedMembers.hgStatusCache.delete(filePath);
      });
    }
    this._sharedMembers.emitter.emit('did-change-statuses');
  }

  requestPathStatusRefresh(): void {
    this._sharedMembers.manualStatusRefreshRequests.next();
  }

  runCommand(args: Array<string>): Observable<string> {
    return this._sharedMembers.service.runCommand(args).refCount();
  }

  observeExecution(args: Array<string>): Observable<LegacyProcessMessage> {
    return this._sharedMembers.service.observeExecution(args).refCount();
  }
}
