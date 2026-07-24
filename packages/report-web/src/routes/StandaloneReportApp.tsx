// Router fragments + standalone app wrapper.
//
// The CLI-hosted SPA consumes StandaloneReportApp, which owns the
// <BrowserRouter>. finalrun-cloud/web instead spreads reportRouteObjects()
// into its own data router so the report pages share the cloud's outer chrome
// (sidebar, auth, etc.) — that's why the route config is exported as plain
// RouteObject[] without a router wrapper.

import { useEffect, useState, type ReactElement } from 'react';
import {
  BrowserRouter,
  Routes,
  Route,
  useNavigate,
  useParams,
  type RouteObject,
} from 'react-router-dom';
import type { ReportIndexViewModel, ReportRunManifest } from '../artifacts';
import { RunIndexView } from '../ui/pages/RunIndexView';
import { RunDetailView } from '../ui/pages/RunDetailView';
import { fetchReportIndex, fetchReportRun } from '../fetchers';

export interface ReportDataSource {
  fetchIndex(): Promise<ReportIndexViewModel>;
  fetchRun(runId: string): Promise<ReportRunManifest>;
}

export const defaultCliDataSource: ReportDataSource = {
  fetchIndex: fetchReportIndex,
  fetchRun: fetchReportRun,
};

export interface ReportRouteObjectsOptions {
  dataSource: ReportDataSource;
  indexPath?: string;
  detailPath?: string;
  backHref?: string;
}

// Returns React Router v7 RouteObject fragments suitable for spreading into a
// parent `createBrowserRouter([...])` config. Default paths match the OSS
// CLI-hosted SPA; finalrun-cloud passes overrides that match its `/runs`
// prefix and its own data source.
export function reportRouteObjects(options: ReportRouteObjectsOptions): RouteObject[] {
  const indexPath = options.indexPath ?? '/';
  const detailPath = options.detailPath ?? '/runs/:runId';
  const backHref = options.backHref ?? indexPath;

  return [
    {
      path: indexPath,
      element: <RunIndexRoute dataSource={options.dataSource} />,
    },
    {
      path: detailPath,
      element: <RunDetailRoute dataSource={options.dataSource} backHref={backHref} />,
    },
  ];
}

export function StandaloneReportApp({
  dataSource = defaultCliDataSource,
}: {
  dataSource?: ReportDataSource;
} = {}): ReactElement {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<RunIndexRoute dataSource={dataSource} />} />
        <Route
          path="/runs/:runId"
          element={<RunDetailRoute dataSource={dataSource} backHref="/" />}
        />
      </Routes>
    </BrowserRouter>
  );
}

function RunIndexRoute({ dataSource }: { dataSource: ReportDataSource }): ReactElement {
  const navigate = useNavigate();
  const state = useAsyncResource(() => dataSource.fetchIndex(), []);

  if (state.status === 'pending') return <LoadingShell />;
  if (state.status === 'error') return <ErrorShell title="Unable to load report index" message={state.error} />;

  return <RunIndexView index={state.data} navigate={(href) => navigate(href)} />;
}

function RunDetailRoute({
  dataSource,
  backHref,
}: {
  dataSource: ReportDataSource;
  backHref: string;
}): ReactElement {
  const params = useParams<{ runId: string }>();
  const navigate = useNavigate();
  const runId = params.runId ?? '';

  const state = useAsyncResource(() => dataSource.fetchRun(runId), [runId]);

  if (!runId) {
    return <ErrorShell title="Missing run id" message="No run id was provided in the URL." />;
  }
  if (state.status === 'pending') return <LoadingShell />;
  if (state.status === 'error') {
    return <ErrorShell title={`Unable to load run ${runId}`} message={state.error} />;
  }

  return (
    <RunDetailView
      manifest={state.data}
      navigate={(href) => navigate(href)}
      backHref={backHref}
    />
  );
}

type AsyncState<T> =
  | { status: 'pending' }
  | { status: 'success'; data: T }
  | { status: 'error'; error: string };

function useAsyncResource<T>(load: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ status: 'pending' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'pending' });
    load().then(
      (data) => {
        if (!cancelled) setState({ status: 'success', data });
      },
      (error) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setState({ status: 'error', error: message });
      },
    );
    return () => {
      cancelled = true;
    };
  }, deps);

  return state;
}

function LoadingShell(): ReactElement {
  return (
    <div className="fr-report-ui">
      <main className="page">
        <section className="empty-state" style={{ marginTop: 64 }}>
          Loading…
        </section>
      </main>
    </div>
  );
}

function ErrorShell({ title, message }: { title: string; message: string }): ReactElement {
  return (
    <div className="fr-report-ui">
      <main className="page">
        <section className="empty-state" style={{ marginTop: 64 }}>
          <h1 style={{ marginBottom: 8 }}>{title}</h1>
          <p>{message}</p>
        </section>
      </main>
    </div>
  );
}
