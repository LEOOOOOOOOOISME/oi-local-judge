import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { ProtectedRoute } from './components/ProtectedRoute';
import { ContestOverviewPage } from './pages/ContestOverviewPage';
import { ContestRankingPage } from './pages/ContestRankingPage';
import { ContestsPage } from './pages/ContestsPage';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { ProblemPage } from './pages/ProblemPage';
import { ProblemsPage } from './pages/ProblemsPage';
import { RecordsPage } from './pages/RecordsPage';
import { SubmissionDetailPage } from './pages/SubmissionDetailPage';

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
