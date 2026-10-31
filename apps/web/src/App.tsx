import { lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { ProtectedRoute } from './components/ProtectedRoute';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';

// 路由级懒加载：AppShell/登录页保持首屏，其余页面按需加载。
// AppShell 内部用 Suspense 包裹 Outlet，懒加载时保留顶栏与整体布局。
const ContestsPage = lazy(() =>
  import('./pages/ContestsPage').then((module) => ({ default: module.ContestsPage })),
);
const ProblemsPage = lazy(() =>
  import('./pages/ProblemsPage').then((module) => ({ default: module.ProblemsPage })),
);
const ProblemPage = lazy(() =>
  import('./pages/ProblemPage').then((module) => ({ default: module.ProblemPage })),
);
const ContestOverviewPage = lazy(() =>
  import('./pages/ContestOverviewPage').then((module) => ({
    default: module.ContestOverviewPage,
  })),
);
const ContestRankingPage = lazy(() =>
  import('./pages/ContestRankingPage').then((module) => ({
    default: module.ContestRankingPage,
  })),
);
const SubmissionDetailPage = lazy(() =>
  import('./pages/SubmissionDetailPage').then((module) => ({
    default: module.SubmissionDetailPage,
  })),
);
const RecordsPage = lazy(() =>
  import('./pages/RecordsPage').then((module) => ({ default: module.RecordsPage })),
);

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/contests" replace />} />
        <Route path="/contests" element={<ContestsPage />} />
        <Route path="/problems" element={<ProblemsPage />} />
        <Route path="/problem/:problemId" element={<ProblemPage />} />
        <Route path="/contest/:contestId" element={<ContestOverviewPage />} />
        <Route path="/contest/:contestId/ranking" element={<ContestRankingPage />} />
        <Route path="/contest/:contestId/problem/:problemId" element={<ProblemPage />} />
        <Route
          path="/submissions/:submissionId"
          element={
            <ProtectedRoute>
              <SubmissionDetailPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/records"
          element={
            <ProtectedRoute>
              <RecordsPage />
            </ProtectedRoute>
          }
        />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
