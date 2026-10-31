import { lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AdminRoute } from './components/AdminRoute';
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
const AdminProblemsPage = lazy(() =>
  import('./pages/AdminProblemsPage').then((module) => ({ default: module.AdminProblemsPage })),
);
const AdminProblemPage = lazy(() =>
  import('./pages/AdminProblemPage').then((module) => ({ default: module.AdminProblemPage })),
);
const AdminBatchPage = lazy(() =>
  import('./pages/AdminBatchPage').then((module) => ({ default: module.AdminBatchPage })),
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
        <Route path="/admin" element={<Navigate to="/admin/problems" replace />} />
        <Route
          path="/admin/problems"
          element={
            <AdminRoute>
              <AdminProblemsPage />
            </AdminRoute>
          }
        />
        <Route
          path="/admin/problems/:problemId"
          element={
            <AdminRoute>
              <AdminProblemPage />
            </AdminRoute>
          }
        />
        <Route
          path="/admin/batch"
          element={
            <AdminRoute>
              <AdminBatchPage />
            </AdminRoute>
          }
        />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
