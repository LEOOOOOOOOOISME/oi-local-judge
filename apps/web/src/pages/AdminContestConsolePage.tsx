import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Spin,
  Table,
  Tag,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiDelete, apiGet, apiPatch, apiPost, apiPut } from '../api/client';
import type {
  AdminUser,
  ClassStatRow,
  ContestDetail,
  ContestDetailProblem,
  ContestParticipant,
  ContestParticipantImportResult,
  ContestRankingRuleConfig,
  ContestLockRecord,
  HackAuditItem,
  RankingPlugin,
  TeamMode,
  TeamRegistration,
  TeamSummary,
  UpdateContestRequest,
} from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { useContestAnnouncements } from '../components/ContestAnnouncements';
import { PageHead } from '../components/PageHead';
import { ErrorResult, PageLoading } from '../components/PageStates';
import { formatDateTime } from '../utils/format';
import { fetchOfficialRanking, presetLabel } from '../utils/officialRanking';
import {
  findTeamByIdOrName,
  resolveTeamMode,
  TEAM_MODE_OPTIONS,
  teamModeLabel,
} from '../utils/teamContest';
import {
  contestModeLabel,
  contestStatusLabel,
} from '../utils/status';
import {
  fromLocalDateTimeInput,
  toLocalDateTimeInput,
} from '../utils/datetime';
import '../styles/admin.css';
import '../styles/contest-admin.css';

interface ContestFormValues {
  name: string;
  mode: string;
  teamMode: TeamMode;
  startAt: string;
  endAt: string;
  freezeAt?: string;
}

const STATUS_COLOR: Record<string, string> = {
  draft: 'default',
  running: 'blue',
  frozen: 'gold',
  ended: 'default',
};

function userLabel(user: AdminUser): string {
  return `${user.realName ?? user.username} (${user.username}${
    user.className ? ` · ${user.className}` : ''
  })`;
}

function describeTeamRegistrationError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'TEAM_NOT_FOUND':
        return '团队不存在，请检查团队 ID';
      case 'TEAM_ALREADY_REGISTERED':
        return '该团队已经报名本场比赛';
      case 'TEAM_MEMBER_CONFLICT':
        return error.message || '团队成员已代表其他团队报名本场比赛';
      case 'TEAM_MODE_DISABLED':
        return '该比赛尚未开启团队报名，请先把报名模式改为团队赛或个人/团队均可';
      case 'CONTEST_ARCHIVED':
        return '比赛已归档，不能修改团队报名';
      case 'TEAM_FORBIDDEN':
        return '没有权限修改该团队报名';
      default:
        return error.message;
    }
  }
  return error instanceof Error ? error.message : '团队报名操作失败';
}

export function AdminContestConsolePage() {
  const { contestId: contestIdParam } = useParams<{ contestId: string }>();
  const contestId = Number(contestIdParam);
  const validId = Number.isInteger(contestId) && contestId > 0;
  const { message } = App.useApp();
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<ContestFormValues>();
  const [savingBasic, setSavingBasic] = useState(false);
  const [basicError, setBasicError] = useState<string | null>(null);
  const [pointsDraft, setPointsDraft] = useState<Record<number, number>>({});
  const [savingPoints, setSavingPoints] = useState(false);
  const [statusLoading, setStatusLoading] = useState<string | null>(null);
  const [selectedUserIds, setSelectedUserIds] = useState<number[]>([]);
  const [addingParticipants, setAddingParticipants] = useState(false);
  const [removingUserId, setRemovingUserId] = useState<number | null>(null);
  const [teamIdentifier, setTeamIdentifier] = useState('');
  const [addingTeam, setAddingTeam] = useState(false);
  const [removingTeamId, setRemovingTeamId] = useState<number | null>(null);
  const [extraDraft, setExtraDraft] = useState<Record<number, number>>({});
  const [savingExtraUserId, setSavingExtraUserId] = useState<number | null>(null);
  const [announcementTitle, setAnnouncementTitle] = useState('');
  const [announcementBody, setAnnouncementBody] = useState('');
  const [publishingAnnouncement, setPublishingAnnouncement] = useState(false);
  const [deletingContest, setDeletingContest] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [releasingOfficialFreeze, setReleasingOfficialFreeze] = useState(false);
  const [hackAuditFilter, setHackAuditFilter] = useState<
    'all' | 'success' | 'failed' | 'invalid' | 'reverted' | 'pending'
  >('all');
  const [promotingAuditHackId, setPromotingAuditHackId] = useState<number | null>(null);
  const [revertingAuditHackId, setRevertingAuditHackId] = useState<number | null>(null);
  const [hiddenOverrides, setHiddenOverrides] = useState<Record<number, boolean>>({});
  const [togglingHiddenUserId, setTogglingHiddenUserId] = useState<number | null>(null);
  const [csvModalOpen, setCsvModalOpen] = useState(false);
  const [csvText, setCsvText] = useState('');
  const [importingCsv, setImportingCsv] = useState(false);
  const [csvResult, setCsvResult] = useState<ContestParticipantImportResult | null>(null);
  const [csvError, setCsvError] = useState<string | null>(null);
  const [rankingPreset, setRankingPreset] = useState('oi');
  const [rankingTie, setRankingTie] = useState<'same-rank' | 'none'>('same-rank');
  const [rankingDecay, setRankingDecay] = useState(0.5);
  const [hackPoints, setHackPoints] = useState(100);
  const [failedHackPenalty, setFailedHackPenalty] = useState(50);
  const [hackWindowMinutes, setHackWindowMinutes] = useState(0);
  const [officialFreezeMinutes, setOfficialFreezeMinutes] = useState(0);
  const [savingRanking, setSavingRanking] = useState(false);
  const [rankingError, setRankingError] = useState<string | null>(null);
  const [unlockingLock, setUnlockingLock] = useState<string | null>(null);

  const detailQuery = useQuery({
    queryKey: ['contest-detail', contestId],
    queryFn: () => apiGet<ContestDetail>(`/api/contests/${contestId}`),
    enabled: validId,
    staleTime: 5_000,
  });
  const participantsQuery = useQuery({
    queryKey: ['admin-participants', contestId],
    queryFn: () => apiGet<ContestParticipant[]>(`/api/admin/contests/${contestId}/participants`),
    enabled: validId,
  });
  const contestTeamsQuery = useQuery({
    queryKey: ['admin-contest-teams', contestId],
    queryFn: () => apiGet<TeamRegistration[]>(`/api/contests/${contestId}/teams`),
    enabled: validId,
    staleTime: 10_000,
  });
  const myTeamsQuery = useQuery({
    queryKey: ['teams'],
    queryFn: () => apiGet<TeamSummary[]>('/api/teams'),
    staleTime: 30_000,
  });
  const classStatsQuery = useQuery({
    queryKey: ['admin-class-stats', contestId],
    queryFn: () => apiGet<ClassStatRow[]>(`/api/admin/contests/${contestId}/class-stats`),
    enabled: validId,
  });
  const usersQuery = useQuery({
    queryKey: ['admin-users', 'contest-console'],
    queryFn: () => apiGet<AdminUser[]>('/api/admin/users?limit=500'),
    staleTime: 30_000,
  });
  const announcementsQuery = useContestAnnouncements(contestId);
  const officialQuery = useQuery({
    queryKey: ['official-ranking', contestId],
    queryFn: () => fetchOfficialRanking(contestId),
    enabled: validId,
    staleTime: 5_000,
    retry: false,
  });
  const rankingConfigQuery = useQuery({
    queryKey: ['ranking-config', contestId],
    queryFn: () => apiGet<ContestRankingRuleConfig>(`/api/admin/contests/${contestId}/ranking-config`),
    enabled: validId,
  });
  const rankingPluginsQuery = useQuery({
    queryKey: ['ranking-plugins'],
    queryFn: () => apiGet<RankingPlugin[]>('/api/admin/ranking-plugins'),
    enabled: validId && user?.role === 'admin',
  });
  const locksQuery = useQuery({
    queryKey: ['admin-contest-locks', contestId],
    queryFn: () => apiGet<ContestLockRecord[]>(`/api/admin/contests/${contestId}/locks`),
    enabled: validId,
    refetchInterval: 5_000,
  });
  const hackAuditQuery = useQuery({
    queryKey: ['admin-hack-audit', contestId],
    queryFn: () => apiGet<HackAuditItem[]>(`/api/admin/contests/${contestId}/hacks`),
    enabled: validId,
    refetchInterval: 10_000,
  });

  const detail = detailQuery.data ?? null;
  const contest = detail?.contest ?? null;
  const problems = detail?.problems ?? [];
  const participants = participantsQuery.data ?? [];
  const teamRegistrations = contestTeamsQuery.data ?? [];
  // 后端没有“列出全部团队”的接口：名称解析只在当前管理员可见团队 + 已报名团队内进行，
  // 其余情况由管理员直接输入团队 ID（提交后后端校验）。
  const knownTeams = useMemo(() => {
    const byId = new Map<number, TeamSummary>();
    for (const team of myTeamsQuery.data ?? []) byId.set(team.id, team);
    for (const registration of contestTeamsQuery.data ?? []) {
      if (byId.has(registration.teamId)) continue;
      byId.set(registration.teamId, {
        id: registration.teamId,
        name: registration.name,
        ownerId: registration.ownerId,
        createdAt: registration.registeredAt,
        memberCount: registration.members.length,
        role: 'member',
      });
    }
    return [...byId.values()];
  }, [myTeamsQuery.data, contestTeamsQuery.data]);
  const archived = Boolean(contest?.archived_at) || contest?.status === 'archived';
  const officialFrozenUntil =
    contest?.official_frozen_until ?? officialQuery.data?.officialFrozenUntil ?? null;
  const officialFrozen = officialFrozenUntil !== null && officialFrozenUntil > Date.now();
  const officialFrozenText =
    officialFrozenUntil !== null
      ? new Date(officialFrozenUntil).toLocaleTimeString('zh-CN', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        })
      : null;
  const hackAuditRows = hackAuditQuery.data ?? [];
  const hackAuditStats = {
    total: hackAuditRows.length,
    success: hackAuditRows.filter(
      (row) => row.status === 'success' || row.status === 'promoted',
    ).length,
    failed: hackAuditRows.filter((row) => row.status === 'failed').length,
    invalid: hackAuditRows.filter(
      (row) => row.status === 'invalid' || row.status === 'unjudgeable',
    ).length,
    reverted: hackAuditRows.filter((row) => row.status === 'reverted').length,
  };
  const filteredHackAuditRows = hackAuditRows.filter((row) => {
    if (hackAuditFilter === 'success') {
      return row.status === 'success' || row.status === 'promoted';
    }
    if (hackAuditFilter === 'failed') return row.status === 'failed';
    if (hackAuditFilter === 'invalid') {
      return row.status === 'invalid' || row.status === 'unjudgeable';
    }
    if (hackAuditFilter === 'reverted') return row.status === 'reverted';
    if (hackAuditFilter === 'pending') {
      return row.status === 'queued' || row.status === 'judging';
    }
    return true;
  });
  const visibleUserIds = new Set((officialQuery.data?.rows ?? []).map((row) => row.userId));
  const isParticipantHidden = (userId: number) =>
    hiddenOverrides[userId] ??
    (officialQuery.data ? !visibleUserIds.has(userId) : false);
  const enabledPlugins = (rankingPluginsQuery.data ?? []).filter((plugin) => plugin.enabled);
  const builtinPresetOptions = [
    { value: 'oi', label: 'OI' },
    { value: 'ioi', label: 'IOI' },
    { value: 'acm', label: 'ACM' },
    { value: 'cf-like', label: 'CF-like' },
  ];
  const rankingPresetOptions = [
    ...builtinPresetOptions,
    ...enabledPlugins.map((plugin) => ({
      value: `plugin:${plugin.name}`,
      label: `插件：${plugin.name}`,
    })),
  ];
  if (!rankingPresetOptions.some((option) => option.value === rankingPreset)) {
    rankingPresetOptions.push({
      value: rankingPreset,
      label: presetLabel(rankingPreset),
    });
  }

  useEffect(() => {
    if (!contest) return;
    form.setFieldsValue({
      name: contest.name,
      mode: contest.mode,
      teamMode: resolveTeamMode(contest),
      startAt: toLocalDateTimeInput(contest.start_at),
      endAt: toLocalDateTimeInput(contest.end_at),
      freezeAt: toLocalDateTimeInput(contest.freeze_at),
    });
  }, [contest, form]);

  useEffect(() => {
    if (!contest || !rankingConfigQuery.data) return;
    const config = rankingConfigQuery.data;
    const fallback =
      contest.mode === 'acm' ? 'acm' : contest.mode === 'ioi' ? 'ioi' : 'oi';
    setRankingPreset(config.preset ?? fallback);
    setRankingTie(config.tie ?? 'same-rank');
    setRankingDecay(config.cfLike?.decay ?? 0.5);
    setHackPoints(config.cfLike?.hackPoints ?? 100);
    setFailedHackPenalty(config.cfLike?.failedHackPenalty ?? 50);
    setHackWindowMinutes(config.hackWindowMinutes ?? 0);
    setOfficialFreezeMinutes(config.officialFreezeMinutesAfterHack ?? 0);
  }, [contest, rankingConfigQuery.data]);

  useEffect(() => {
    if (!detail) return;
    setPointsDraft(
      Object.fromEntries(detail.problems.map((problem) => [problem.problemId, problem.points])),
    );
  }, [detail]);

  useEffect(() => {
    setExtraDraft(
      Object.fromEntries(participants.map((participant) => [participant.user_id, participant.extra_time])),
    );
  }, [participants]);

  const invalidateContest = () => {
    void queryClient.invalidateQueries({ queryKey: ['contest-detail', contestId] });
    void queryClient.invalidateQueries({ queryKey: ['contests'] });
    void queryClient.invalidateQueries({ queryKey: ['admin-class-stats', contestId] });
    void queryClient.invalidateQueries({ queryKey: ['ranking', contestId] });
    void queryClient.invalidateQueries({ queryKey: ['official-ranking', contestId] });
  };

  const saveBasic = async (values: ContestFormValues) => {
    const startAt = fromLocalDateTimeInput(values.startAt);
    const endAt = fromLocalDateTimeInput(values.endAt);
    if (startAt === null || endAt === null) {
      message.error('请填写有效的开始/结束时间');
      return;
    }
    setSavingBasic(true);
    setBasicError(null);
    try {
      const payload: UpdateContestRequest = {
        name: values.name.trim(),
        mode: values.mode,
        teamMode: values.teamMode,
        startAt,
        endAt,
        freezeAt: fromLocalDateTimeInput(values.freezeAt ?? ''),
      };
      await apiPut<{ id: number }>(`/api/admin/contests/${contestId}`, payload);
      message.success('比赛基本信息已保存');
      invalidateContest();
    } catch (error) {
      const text = error instanceof Error ? error.message : '保存失败';
      setBasicError(text);
      message.error(text);
    } finally {
      setSavingBasic(false);
    }
  };

  const pointsDirty = problems.some(
    (problem) => (pointsDraft[problem.problemId] ?? problem.points) !== problem.points,
  );

  const savePoints = async () => {
    setSavingPoints(true);
    try {
      await apiPut<{ id: number }>(`/api/admin/contests/${contestId}`, {
        problems: problems.map((problem) => ({
          problemId: problem.problemId,
          points: Number(pointsDraft[problem.problemId] ?? problem.points),
        })),
      });
      message.success('题目分值已保存');
      invalidateContest();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存分值失败');
    } finally {
      setSavingPoints(false);
    }
  };

  const runStatusAction = async (action: 'start' | 'freeze' | 'unfreeze' | 'end') => {
    setStatusLoading(action);
    try {
      await apiPost<null>(`/api/admin/contests/${contestId}/${action}`);
      message.success('比赛状态已更新');
      invalidateContest();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '状态更新失败');
    } finally {
      setStatusLoading(null);
    }
  };

  const currentParticipantIds = new Set(participants.map((row) => row.user_id));
  const candidateOptions = (usersQuery.data ?? [])
    .filter((user) => !currentParticipantIds.has(user.id))
    .map((user) => ({ value: user.id, label: userLabel(user) }));

  const addParticipants = async () => {
    if (selectedUserIds.length === 0) return;
    setAddingParticipants(true);
    try {
      const result = await apiPost<{ added: number[]; missing: string[] }>(
        `/api/admin/contests/${contestId}/participants`,
        { userIds: selectedUserIds },
      );
      if (result.missing.length > 0) {
        message.warning(`未找到用户：${result.missing.join('、')}`);
      } else {
        message.success('参赛者已添加');
      }
      setSelectedUserIds([]);
      void queryClient.invalidateQueries({ queryKey: ['admin-participants', contestId] });
      void queryClient.invalidateQueries({ queryKey: ['contest-detail', contestId] });
      void queryClient.invalidateQueries({ queryKey: ['admin-class-stats', contestId] });
      void queryClient.invalidateQueries({ queryKey: ['ranking', contestId] });
    } catch (error) {
      message.error(error instanceof Error ? error.message : '添加参赛者失败');
    } finally {
      setAddingParticipants(false);
    }
  };

  const removeParticipant = async (userId: number) => {
    setRemovingUserId(userId);
    try {
      await apiDelete<null>(`/api/admin/contests/${contestId}/participants/${userId}`);
      message.success('参赛者已移除');
      void queryClient.invalidateQueries({ queryKey: ['admin-participants', contestId] });
      void queryClient.invalidateQueries({ queryKey: ['contest-detail', contestId] });
      void queryClient.invalidateQueries({ queryKey: ['admin-class-stats', contestId] });
      void queryClient.invalidateQueries({ queryKey: ['ranking', contestId] });
    } catch (error) {
      message.error(error instanceof Error ? error.message : '移除参赛者失败');
    } finally {
      setRemovingUserId(null);
    }
  };

  const addTeamRegistration = async () => {
    const raw = teamIdentifier.trim();
    if (raw === '') {
      message.error('请输入团队 ID 或团队名称');
      return;
    }
    const known = findTeamByIdOrName(knownTeams, raw);
    // 未知的纯数字直接交给后端校验；未知名称无法解析（后端没有全量团队搜索接口）。
    const teamId = known?.id ?? (/^\d+$/.test(raw) ? Number(raw) : null);
    if (teamId === null) {
      message.error('未找到该团队；请检查团队名称，或直接输入团队 ID');
      return;
    }
    setAddingTeam(true);
    try {
      await apiPost<null>(`/api/admin/contests/${contestId}/teams`, { teamId });
      message.success('团队已报名');
      setTeamIdentifier('');
      void queryClient.invalidateQueries({ queryKey: ['admin-contest-teams', contestId] });
      void queryClient.invalidateQueries({ queryKey: ['contest-teams', contestId] });
      void queryClient.invalidateQueries({ queryKey: ['team-ranking', contestId] });
    } catch (error) {
      message.error(describeTeamRegistrationError(error));
    } finally {
      setAddingTeam(false);
    }
  };

  const removeTeamRegistration = async (teamId: number) => {
    setRemovingTeamId(teamId);
    try {
      await apiDelete<null>(`/api/admin/contests/${contestId}/teams/${teamId}`);
      message.success('团队报名已移除');
      void queryClient.invalidateQueries({ queryKey: ['admin-contest-teams', contestId] });
      void queryClient.invalidateQueries({ queryKey: ['contest-teams', contestId] });
      void queryClient.invalidateQueries({ queryKey: ['team-ranking', contestId] });
    } catch (error) {
      message.error(describeTeamRegistrationError(error));
    } finally {
      setRemovingTeamId(null);
    }
  };

  const toggleParticipantHidden = async (participant: ContestParticipant) => {
    const nextHidden = !isParticipantHidden(participant.user_id);
    setTogglingHiddenUserId(participant.user_id);
    try {
      await apiPatch<null>(
        `/api/admin/contests/${contestId}/participants/${participant.user_id}`,
        { hidden: nextHidden },
      );
      setHiddenOverrides((previous) => ({
        ...previous,
        [participant.user_id]: nextHidden,
      }));
      message.success(nextHidden ? '已从正式榜隐藏该选手' : '已恢复该选手的正式榜显示');
      void queryClient.invalidateQueries({ queryKey: ['admin-participants', contestId] });
      void queryClient.invalidateQueries({ queryKey: ['official-ranking', contestId] });
      void queryClient.invalidateQueries({ queryKey: ['ranking', contestId] });
    } catch (error) {
      message.error(error instanceof Error ? error.message : '更新名单显示状态失败');
    } finally {
      setTogglingHiddenUserId(null);
    }
  };

  const importParticipantCsv = async () => {
    if (!csvText.trim()) {
      setCsvError('请粘贴名单 CSV');
      return;
    }
    setImportingCsv(true);
    setCsvError(null);
    setCsvResult(null);
    try {
      const result = await apiPost<ContestParticipantImportResult>(
        `/api/admin/contests/${contestId}/participants/import`,
        { csv: csvText },
      );
      setCsvResult(result);
      message.success(`名单导入完成：新增 ${result.added.length} 人，跳过 ${result.skipped.length} 人`);
      void queryClient.invalidateQueries({ queryKey: ['admin-participants', contestId] });
      void queryClient.invalidateQueries({ queryKey: ['official-ranking', contestId] });
      void queryClient.invalidateQueries({ queryKey: ['ranking', contestId] });
    } catch (error) {
      setCsvError(error instanceof Error ? error.message : '名单导入失败');
    } finally {
      setImportingCsv(false);
    }
  };

  const archiveContest = async () => {
    setArchiving(true);
    try {
      await apiPost<null>(`/api/admin/contests/${contestId}/archive`);
      message.success('比赛已归档，正式榜进入只读状态');
      invalidateContest();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '归档比赛失败');
    } finally {
      setArchiving(false);
    }
  };

  const releaseOfficialFreeze = async () => {
    setReleasingOfficialFreeze(true);
    try {
      await apiPost<{ released: boolean }>(
        `/api/admin/contests/${contestId}/official-freeze/release`,
      );
      message.success('官方冻结已解除');
      invalidateContest();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '解除官方冻结失败');
    } finally {
      setReleasingOfficialFreeze(false);
    }
  };

  const promoteAuditHack = async (hackId: number) => {
    setPromotingAuditHackId(hackId);
    try {
      await apiPost<{ id: number; status: string }>(
        `/api/admin/contests/${contestId}/hacks/${hackId}/promote`,
      );
      message.success('已强制晋升为 HACKED');
      void queryClient.invalidateQueries({ queryKey: ['admin-hack-audit', contestId] });
      void queryClient.invalidateQueries({ queryKey: ['official-ranking', contestId] });
      void queryClient.invalidateQueries({ queryKey: ['ranking', contestId] });
    } catch (error) {
      message.error(error instanceof Error ? error.message : '强制晋升失败');
    } finally {
      setPromotingAuditHackId(null);
    }
  };

  const revertAuditHack = async (hackId: number) => {
    setRevertingAuditHackId(hackId);
    try {
      await apiPost<{ id: number; status: string }>(
        `/api/admin/contests/${contestId}/hacks/${hackId}/revert`,
      );
      message.success('已撤销 HACKED，正式分已重算');
      void queryClient.invalidateQueries({ queryKey: ['admin-hack-audit', contestId] });
      void queryClient.invalidateQueries({ queryKey: ['official-ranking', contestId] });
      void queryClient.invalidateQueries({ queryKey: ['ranking', contestId] });
    } catch (error) {
      message.error(error instanceof Error ? error.message : '撤销 HACKED 失败');
    } finally {
      setRevertingAuditHackId(null);
    }
  };

  const unlockProblem = async (record: ContestLockRecord) => {
    const key = `${record.user_id}:${record.problem_id}`;
    setUnlockingLock(key);
    try {
      await apiDelete<null>(
        `/api/admin/contests/${contestId}/locks/${record.user_id}/${record.problem_id}`,
      );
      message.success('已解除该选手本题的锁定');
      void queryClient.invalidateQueries({ queryKey: ['admin-contest-locks', contestId] });
      void queryClient.invalidateQueries({
        queryKey: ['hack-targets', contestId, record.problem_id],
      });
      void queryClient.invalidateQueries({
        queryKey: ['hack-history', contestId, record.problem_id],
      });
      void queryClient.invalidateQueries({ queryKey: ['official-ranking', contestId] });
    } catch (error) {
      message.error(error instanceof Error ? error.message : '解锁失败');
    } finally {
      setUnlockingLock(null);
    }
  };

  const saveRankingConfig = async () => {
    setSavingRanking(true);
    setRankingError(null);
    try {
      await apiPut<ContestRankingRuleConfig>(
        `/api/admin/contests/${contestId}/ranking-config`,
        {
          preset: rankingPreset,
          tie: rankingTie,
          hackWindowMinutes,
          officialFreezeMinutesAfterHack: officialFreezeMinutes,
          cfLike: {
            decay: rankingDecay,
            hackPoints,
            failedHackPenalty,
          },
        },
      );
      message.success('排名规则已保存');
      void queryClient.invalidateQueries({ queryKey: ['ranking-config', contestId] });
      void queryClient.invalidateQueries({ queryKey: ['official-ranking', contestId] });
      void queryClient.invalidateQueries({ queryKey: ['ranking', contestId] });
    } catch (error) {
      const text = error instanceof Error ? error.message : '保存排名规则失败';
      setRankingError(text);
      message.error(text);
    } finally {
      setSavingRanking(false);
    }
  };

  const saveExtraTime = async (participant: ContestParticipant) => {    const value = extraDraft[participant.user_id];
    if (!Number.isFinite(value) || value < 0) {
      message.error('加时秒数必须是非负数字');
      return;
    }
    setSavingExtraUserId(participant.user_id);
    try {
      await apiPut<null>(
        `/api/admin/contests/${contestId}/participants/${participant.user_id}`,
        { extraTime: Number(value), status: participant.status },
      );
      message.success(`已保存 ${participant.username} 的加时`);
      void queryClient.invalidateQueries({ queryKey: ['admin-participants', contestId] });
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存加时失败');
    } finally {
      setSavingExtraUserId(null);
    }
  };

  const publishAnnouncement = async () => {
    if (!announcementTitle.trim() || !announcementBody.trim()) {
      message.warning('请输入公告标题和正文');
      return;
    }
    setPublishingAnnouncement(true);
    try {
      await apiPost<{ id: number; status: string }>('/api/posts', {
        category: 'announcement',
        title: announcementTitle.trim(),
        body: announcementBody,
        contestId,
      });
      message.success('比赛公告已发布');
      setAnnouncementTitle('');
      setAnnouncementBody('');
      void queryClient.invalidateQueries({
        queryKey: ['contest-announcements', contestId],
      });
      void queryClient.invalidateQueries({ queryKey: ['posts'] });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'RATE_LIMITED') {
        message.error('发帖过于频繁，请稍后再试');
      } else {
        message.error(error instanceof Error ? error.message : '发布公告失败');
      }
    } finally {
      setPublishingAnnouncement(false);
    }
  };

  const deleteContest = async () => {
    setDeletingContest(true);
    try {
      await apiDelete<null>(`/api/admin/contests/${contestId}`);
      message.success('比赛已删除');
      void queryClient.invalidateQueries({ queryKey: ['contests'] });
      navigate('/admin/contests');
    } catch (error) {
      if (error instanceof ApiError && error.code === 'HAS_SUBMISSIONS') {
        message.error('已有提交，无法删除');
      } else {
        message.error(error instanceof Error ? error.message : '删除比赛失败');
      }
    } finally {
      setDeletingContest(false);
    }
  };

  const problemColumns: TableColumnsType<ContestDetailProblem> = [
    {
      title: '编号',
      dataIndex: 'ordinal',
      width: 64,
      render: (value: number) => <span className="mono">{value}</span>,
    },
    {
      title: '题目',
      dataIndex: 'title',
      render: (_value, row) => (
        <Link to={`/problem/${row.problemId}`}>{row.title}</Link>
      ),
    },
    {
      title: '分值',
      width: 130,
      render: (_value, row) => (
        <InputNumber
          size="small"
          min={0}
          max={10000}
          precision={0}
          value={pointsDraft[row.problemId] ?? row.points}
          onChange={(value) =>
            setPointsDraft((previous) => ({
              ...previous,
              [row.problemId]: typeof value === 'number' ? value : 0,
            }))
          }
          style={{ width: 96 }}
        />
      ),
    },
  ];

  const participantColumns: TableColumnsType<ContestParticipant> = [
    { title: '用户名', dataIndex: 'username', width: 150 },
    {
      title: '姓名',
      dataIndex: 'real_name',
      width: 140,
      render: (value: string | null) => value ?? <span className="muted">—</span>,
    },
    {
      title: '班级',
      dataIndex: 'class_name',
      width: 150,
      render: (value: string | null) => value ?? <span className="muted">—</span>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 130,
      render: (value: string, row) => (
        <Space size={4} wrap>
          <Tag>{value}</Tag>
          {isParticipantHidden(row.user_id) ? <Tag color="red">已隐藏</Tag> : null}
        </Space>
      ),
    },
    {
      title: '加时(秒)',
      width: 190,
      render: (_value, row) => (
        <Space size={6}>
          <InputNumber
            className="extra-time-input"
            size="small"
            min={0}
            max={86400}
            precision={0}
            value={extraDraft[row.user_id] ?? row.extra_time}
            onChange={(value) =>
              setExtraDraft((previous) => ({
                ...previous,
                [row.user_id]: typeof value === 'number' ? value : 0,
              }))
            }
            style={{ width: 92 }}
          />
          <Button
            size="small"
            loading={savingExtraUserId === row.user_id}
            onClick={() => void saveExtraTime(row)}
          >
            保存加时
          </Button>
        </Space>
      ),
    },
    {
      title: '名单',
      width: 86,
      align: 'center',
      render: (_value, row) => (
        <Button
          size="small"
          loading={togglingHiddenUserId === row.user_id}
          onClick={() => void toggleParticipantHidden(row)}
        >
          {isParticipantHidden(row.user_id) ? '恢复' : '隐藏'}
        </Button>
      ),
    },
    {
      title: '',
      width: 76,
      align: 'center',
      render: (_value, row) => (
        <Popconfirm
          title={`移除参赛者 ${row.username}？`}
          okText="移除"
          cancelText="取消"
          onConfirm={() => void removeParticipant(row.user_id)}
        >
          <Button size="small" danger loading={removingUserId === row.user_id}>
            移除
          </Button>
        </Popconfirm>
      ),
    },
  ];

  const teamRegistrationColumns: TableColumnsType<TeamRegistration> = [
    {
      title: '团队',
      dataIndex: 'name',
      width: 220,
      render: (value: string, row) => (
        <span>
          {value}
          <span className="muted mono"> #{row.teamId}</span>
        </span>
      ),
    },
    {
      title: '成员',
      width: 320,
      render: (_value, row) =>
        row.members.length === 0 ? (
          <span className="muted">暂无成员</span>
        ) : (
          <span>{row.members.map((member) => member.realName ?? member.username).join('、')}</span>
        ),
    },
    {
      title: '报名时间',
      dataIndex: 'registeredAt',
      width: 170,
      render: (value: number) => <span className="mono">{formatDateTime(value)}</span>,
    },
    {
      title: '',
      width: 90,
      align: 'center',
      render: (_value, row) => (
        <Popconfirm
          title={`移除团队 ${row.name} 的报名？`}
          description="已提交的代码仍保留原团队归属，但该团队不再参与团队榜。"
          okText="移除"
          cancelText="取消"
          onConfirm={() => void removeTeamRegistration(row.teamId)}
        >
          <Button size="small" danger loading={removingTeamId === row.teamId}>
            移除
          </Button>
        </Popconfirm>
      ),
    },
  ];

  const lockColumns: TableColumnsType<ContestLockRecord> = [
    {
      title: '选手',
      dataIndex: 'username',
      width: 180,
      render: (value: string, row) => (
        <span>
          {row.real_name ?? value}
          <span className="muted"> @{value}</span>
        </span>
      ),
    },
    {
      title: '题目',
      dataIndex: 'problem_title',
      render: (value: string, row) => (
        <span>
          {value}
          <span className="muted mono"> #{row.problem_id}</span>
        </span>
      ),
    },
    {
      title: '锁定时间',
      dataIndex: 'locked_at',
      width: 170,
      render: (value: number) => (
        <span className="mono">{formatDateTime(value)}</span>
      ),
    },
    {
      title: '',
      width: 100,
      align: 'center',
      render: (_value, row) => {
        const key = `${row.user_id}:${row.problem_id}`;
        return (
          <Popconfirm
            title="解除该选手本题的锁定？"
            description="解锁后选手可再次提交，targets 将不可见。"
            okText="解锁"
            cancelText="取消"
            onConfirm={() => void unlockProblem(row)}
          >
            <Button size="small" loading={unlockingLock === key}>
              解锁
            </Button>
          </Popconfirm>
        );
      },
    },
  ];

  const auditStatusLabel: Record<string, string> = {
    queued: '排队中',
    judging: '评测中',
    success: '成功',
    failed: '失败',
    invalid: '非法',
    unjudgeable: '无法判定',
    promoted: '已晋升',
    reverted: '已撤销',
  };
  const auditStatusColor: Record<string, string> = {
    queued: 'blue',
    judging: 'blue',
    success: 'green',
    failed: 'default',
    invalid: 'orange',
    unjudgeable: 'default',
    promoted: 'green',
    reverted: 'default',
  };

  const hackAuditColumns: TableColumnsType<HackAuditItem> = [
    {
      title: '时间',
      dataIndex: 'created_at',
      width: 158,
      render: (value: number) => <span className="mono">{formatDateTime(value)}</span>,
    },
    {
      title: 'Hacker',
      dataIndex: 'hacker_username',
      width: 130,
      render: (value: string | null, row) => (
        <span>
          {value ?? `用户 #${row.hacker_id}`}
          <span className="muted mono"> #{row.hacker_id}</span>
        </span>
      ),
    },
    {
      title: '目标选手',
      dataIndex: 'target_username',
      width: 150,
      render: (value: string | null, row) => (
        <span>
          {row.target_real_name ?? value ?? '—'}
          <span className="muted"> @{value ?? '—'}</span>
        </span>
      ),
    },
    {
      title: '题目',
      dataIndex: 'problem_title',
      width: 150,
      render: (value: string, row) => (
        <span>
          {value}
          <span className="muted mono"> #{row.problem_id}</span>
        </span>
      ),
    },
    {
      title: '目标结果',
      dataIndex: 'target_verdict',
      width: 110,
      render: (value: HackAuditItem['target_verdict'], row) => (
        <span className="mono">
          {value ?? '—'} / {row.target_score ?? 0} 分
        </span>
      ),
    },
    {
      title: 'Hack 状态',
      dataIndex: 'status',
      width: 112,
      render: (value: HackAuditItem['status']) =>
        value === 'success' || value === 'promoted' ? (
          <span className="hack-hacked-label">HACKED</span>
        ) : (
          <Tag color={auditStatusColor[value] ?? 'default'}>
            {auditStatusLabel[value] ?? value}
          </Tag>
        ),
    },
    {
      title: 'Hack 结果',
      dataIndex: 'verdict',
      width: 92,
      render: (value: HackAuditItem['verdict']) =>
        value ? <Tag>{value}</Tag> : <span className="muted">—</span>,
    },
    {
      title: '信息',
      dataIndex: 'message',
      render: (value: string) =>
        value ? (
          <span className="test-message" title={value}>
            {value}
          </span>
        ) : (
          <span className="muted">—</span>
        ),
    },
    {
      title: '',
      width: 120,
      align: 'center',
      render: (_value, row) => {
        if (row.status === 'failed' || row.status === 'queued') {
          return (
            <Popconfirm
              title="强制晋升为 HACKED？"
              description="会标记目标提交为 HACKED 并重算正式分。"
              okText="晋升"
              cancelText="取消"
              onConfirm={() => void promoteAuditHack(row.id)}
            >
              <Button
                size="small"
                danger
                loading={promotingAuditHackId === row.id}
              >
                强制晋升
              </Button>
            </Popconfirm>
          );
        }
        if (row.status === 'success' || row.status === 'promoted') {
          return (
            <Popconfirm
              title="撤销 HACKED？"
              description="清除目标提交的 HACKED 状态并按剩余提交重算正式分。"
              okText="撤销"
              cancelText="取消"
              onConfirm={() => void revertAuditHack(row.id)}
            >
              <Button size="small" loading={revertingAuditHackId === row.id}>
                撤销 HACKED
              </Button>
            </Popconfirm>
          );
        }
        return null;
      },
    },
  ];

  const classColumns: TableColumnsType<ClassStatRow> = [
    { title: '班级', dataIndex: 'className' },
    { title: '人数', dataIndex: 'participants', width: 80, align: 'right' },
    { title: '总分', dataIndex: 'totalScore', width: 90, align: 'right' },
    {
      title: '均分',
      dataIndex: 'averageScore',
      width: 90,
      align: 'right',
      render: (value: number) => value.toFixed(1),
    },
    { title: 'AC 人数', dataIndex: 'acParticipants', width: 96, align: 'right' },
    { title: '最好名次', dataIndex: 'bestRank', width: 90, align: 'right' },
  ];

  if (!validId) {
    return <ErrorResult error={new Error('无效的比赛编号')} />;
  }
  if (detailQuery.isPending) {
    return <PageLoading tip="正在加载比赛…" />;
  }
  if (detailQuery.isError) {
    return (
      <ErrorResult error={detailQuery.error} onRetry={() => void detailQuery.refetch()} />
    );
  }
  if (!contest) {
    return <ErrorResult error={new Error('比赛不存在')} />;
  }

  const status = contest.status;
  const statusColor = STATUS_COLOR[status] ?? 'default';
  const currentTeamMode = resolveTeamMode(contest);
  const teamRegistrationEnabled = currentTeamMode !== 'individual';

  return (
    <div>
      <PageHead
        breadcrumb={[
          { label: '管理', to: '/admin/problems' },
          { label: '比赛管理', to: '/admin/contests' },
          { label: contest.name },
        ]}
        title={contest.name}
        tags={
          <>
            <Tag className="mono">#{contest.id}</Tag>
            <Tag color={statusColor}>{contestStatusLabel(status)}</Tag>
            <Tag color="blue">{contestModeLabel(contest.mode)}</Tag>
            <Tag color={teamRegistrationEnabled ? 'purple' : 'default'}>
              {teamModeLabel(currentTeamMode)}
            </Tag>
            {archived ? <Tag color="red">已归档 · 只读</Tag> : null}
            {officialFrozen ? (
              <Tag color="gold">官方分冻结至 {officialFrozenText}</Tag>
            ) : null}
            {officialFrozen ? (
              <Popconfirm
                title="解除官方冻结？"
                description="解除后正式分立即恢复更新。"
                okText="解除"
                cancelText="取消"
                onConfirm={() => void releaseOfficialFreeze()}
              >
                <Button size="small" loading={releasingOfficialFreeze}>
                  解除冻结
                </Button>
              </Popconfirm>
            ) : null}
          </>
        }
        subtitle={`开始 ${formatDateTime(contest.start_at)} · 结束 ${formatDateTime(
          contest.end_at,
        )} · 参赛人数 ${detail?.participantCount ?? participants.length}`}
        extra={
          <Space>
            <Link to={`/contest/${contest.id}`}>
              <Button>公开比赛页</Button>
            </Link>
            <Link to={`/contest/${contest.id}/ranking`}>
              <Button>榜单</Button>
            </Link>
            {archived || contest.mode !== 'oi' ? (
              <Button disabled>批量导入</Button>
            ) : (
              <Link to={`/admin/contests/${contest.id}/batch`}>
                <Button>批量导入</Button>
              </Link>
            )}
            <Popconfirm
              title="归档这场比赛？"
              description="归档后正式榜只读，批量导入与再次归档将禁用；此操作不可逆。"
              okText="归档"
              cancelText="取消"
              disabled={archived}
              onConfirm={() => void archiveContest()}
            >
              <Button danger disabled={archived} loading={archiving}>
                {archived ? '已归档' : '归档比赛'}
              </Button>
            </Popconfirm>
            <Link to="/admin/contests">
              <Button>返回列表</Button>
            </Link>
            <Popconfirm
              title="删除这场比赛？"
              description="此操作不可恢复；已有提交的比赛无法删除。"
              okText="删除"
              cancelText="取消"
              onConfirm={() => void deleteContest()}
            >
              <Button danger loading={deletingContest}>
                删除比赛
              </Button>
            </Popconfirm>
          </Space>
        }
      />

      <div className="stack">
        <Card
          className="oij-card"
          title="基本信息"
          extra={
            <Button
              type="primary"
              loading={savingBasic}
              onClick={() => form.submit()}
            >
              保存
            </Button>
          }
        >
          <Form<ContestFormValues>
            form={form}
            layout="vertical"
            requiredMark={false}
            onFinish={(values) => void saveBasic(values)}
          >
            <Row gutter={12}>
              <Col span={10}>
                <Form.Item
                  label="比赛名称"
                  name="name"
                  rules={[{ required: true, message: '请输入比赛名称' }]}
                >
                  <Input maxLength={120} showCount />
                </Form.Item>
              </Col>
              <Col span={4}>
                <Form.Item label="赛制" name="mode" rules={[{ required: true }]}>
                  <Select
                    options={[
                      { value: 'oi', label: 'OI' },
                      { value: 'acm', label: 'ACM' },
                    ]}
                  />
                </Form.Item>
              </Col>
              <Col span={5}>
                <Form.Item
                  label="开始时间"
                  name="startAt"
                  rules={[{ required: true, message: '请选择开始时间' }]}
                >
                  <Input type="datetime-local" />
                </Form.Item>
              </Col>
              <Col span={5}>
                <Form.Item
                  label="结束时间"
                  name="endAt"
                  rules={[{ required: true, message: '请选择结束时间' }]}
                >
                  <Input type="datetime-local" />
                </Form.Item>
              </Col>
            </Row>
            <Row gutter={12}>
              <Col span={8}>
                <Form.Item label="报名模式" name="teamMode" rules={[{ required: true }]}>
                  <Select<TeamMode> options={TEAM_MODE_OPTIONS} />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item label="封榜时间（可空）" name="freezeAt">
                  <Input type="datetime-local" />
                </Form.Item>
              </Col>
            </Row>
          </Form>
          {basicError ? (
            <Alert type="error" showIcon message={basicError} />
          ) : null}
        </Card>

        <Card
          className="oij-card"
          title="题目与分值"
          extra={
            <Button
              type="primary"
              disabled={!pointsDirty}
              loading={savingPoints}
              onClick={() => void savePoints()}
            >
              保存分值
            </Button>
          }
        >
          {problems.length === 0 ? (
            <Empty description="尚未配置比赛题目" />
          ) : (
            <Table<ContestDetailProblem>
              className="oij-table"
              rowKey="problemId"
              size="small"
              columns={problemColumns}
              dataSource={problems}
              pagination={false}
            />
          )}
        </Card>

        <Card className="oij-card" title="状态控制">
          <div className="contest-status-row">
            <span className="muted">当前状态</span>
            <Tag color={statusColor}>{contestStatusLabel(status)}</Tag>
            <Space wrap>
              <Button
                type="primary"
                disabled={status !== 'draft'}
                loading={statusLoading === 'start'}
                onClick={() => void runStatusAction('start')}
              >
                开始
              </Button>
              <Button
                disabled={status !== 'running'}
                loading={statusLoading === 'freeze'}
                onClick={() => void runStatusAction('freeze')}
              >
                封榜
              </Button>
              <Button
                disabled={status !== 'frozen'}
                loading={statusLoading === 'unfreeze'}
                onClick={() => void runStatusAction('unfreeze')}
              >
                解封
              </Button>
              <Button
                danger
                disabled={status === 'ended'}
                loading={statusLoading === 'end'}
                onClick={() => void runStatusAction('end')}
              >
                结束
              </Button>
            </Space>
          </div>
        </Card>

        <Card
          className="oij-card"
          title="排名规则"
          extra={
            <Button type="primary" loading={savingRanking} onClick={() => void saveRankingConfig()}>
              保存排名规则
            </Button>
          }
        >
          <div className="stack">
            {officialQuery.data?.pluginError ? (
              <Alert
                type="error"
                showIcon
                message="排名插件加载失败，当前已回退 OI"
                description={officialQuery.data.pluginError}
              />
            ) : null}
            {rankingError ? <Alert type="error" showIcon message={rankingError} /> : null}
            <div className="ranking-config-grid">
              <div className="batch-field">
                <span className="muted">排名预设</span>
                <Select
                  value={rankingPreset}
                  options={rankingPresetOptions}
                  onChange={(value: string) => setRankingPreset(value)}
                  style={{ width: 220 }}
                />
              </div>
              <div className="batch-field">
                <span className="muted">并列规则</span>
                <Select
                  value={rankingTie}
                  options={[
                    { value: 'same-rank', label: '同分同名次' },
                    { value: 'none', label: '顺序名次' },
                  ]}
                  onChange={(value: 'same-rank' | 'none') => setRankingTie(value)}
                  style={{ width: 180 }}
                />
              </div>
              <div className="batch-field">
                <span className="muted">CF-like 衰减</span>
                <InputNumber
                  min={0}
                  max={2}
                  step={0.1}
                  precision={1}
                  value={rankingDecay}
                  onChange={(value) =>
                    setRankingDecay(typeof value === 'number' ? value : 0.5)
                  }
                  style={{ width: 150 }}
                />
              </div>
              {rankingPreset === 'cf-like' ? (
                <>
                  <div className="batch-field">
                    <span className="muted">成功 Hack 分</span>
                    <InputNumber
                      min={0}
                      max={1000}
                      precision={0}
                      value={hackPoints}
                      onChange={(value) =>
                        setHackPoints(typeof value === 'number' ? value : 100)
                      }
                      style={{ width: 150 }}
                    />
                  </div>
                  <div className="batch-field">
                    <span className="muted">失败 Hack 罚分</span>
                    <InputNumber
                      min={0}
                      max={1000}
                      precision={0}
                      value={failedHackPenalty}
                      onChange={(value) =>
                        setFailedHackPenalty(typeof value === 'number' ? value : 50)
                      }
                      style={{ width: 150 }}
                    />
                  </div>
                </>
              ) : null}
              <div className="batch-field">
                <span className="muted">Hack 窗口（分钟）</span>
                <InputNumber
                  min={0}
                  max={10080}
                  precision={0}
                  value={hackWindowMinutes}
                  onChange={(value) =>
                    setHackWindowMinutes(typeof value === 'number' ? value : 0)
                  }
                  style={{ width: 150 }}
                />
              </div>
              <div className="batch-field">
                <span className="muted">Hack 后官方冻结（分钟）</span>
                <InputNumber
                  min={0}
                  max={10080}
                  precision={0}
                  value={officialFreezeMinutes}
                  onChange={(value) =>
                    setOfficialFreezeMinutes(typeof value === 'number' ? value : 0)
                  }
                  style={{ width: 170 }}
                />
              </div>
            </div>
            <div className="batch-level-hint muted">
              比赛结束后 N 分钟关闭锁题/Hack；0 表示结束后立即关闭。
              Hack 后官方冻结 N 分钟，期间正式分不更新（批量发布会被拒绝）。
              当前生效：{presetLabel(officialQuery.data?.preset ?? rankingPreset)}。
              自定义插件需先在“排名插件”页上传并启用，重启服务后才会加载；插件失败会自动回退 OI。
            </div>
          </div>
        </Card>

        <Card
          className="oij-card"
          title="比赛公告"
          extra={<span className="muted">{announcementsQuery.data?.length ?? 0} 条</span>}
        >
          <div className="announcement-admin-form">
            <Input
              value={announcementTitle}
              onChange={(event) => setAnnouncementTitle(event.target.value)}
              placeholder="公告标题"
              maxLength={200}
            />
            <Input.TextArea
              value={announcementBody}
              onChange={(event) => setAnnouncementBody(event.target.value)}
              placeholder="Markdown 正文（支持 Markdown）"
              autoSize={{ minRows: 3, maxRows: 7 }}
              maxLength={20000}
            />
            <div className="announcement-admin-actions">
              <span className="muted">发布后选手在比赛页“比赛信息”中可见。</span>
              <Button
                type="primary"
                loading={publishingAnnouncement}
                disabled={!announcementTitle.trim() || !announcementBody.trim()}
                onClick={() => void publishAnnouncement()}
              >
                发布公告
              </Button>
            </div>
          </div>
          {announcementsQuery.isPending ? (
            <div className="inline-loading">
              <Spin />
            </div>
          ) : announcementsQuery.isError ? (
            <ErrorResult
              error={announcementsQuery.error}
              onRetry={() => void announcementsQuery.refetch()}
            />
          ) : !announcementsQuery.data || announcementsQuery.data.length === 0 ? (
            <Empty description="还没有比赛公告" />
          ) : (
            <div className="announcement-admin-list">
              {announcementsQuery.data.map((post, index) => (
                <article className="announcement-item" key={post.id}>
                  <div className="announcement-head">
                    <h3 className="announcement-title">
                      公告 {index + 1} · <Link to={`/discuss/${post.id}`}>{post.title}</Link>
                    </h3>
                    <span className="muted announcement-meta">
                      {post.author.realName ?? post.author.username} ·{' '}
                      {formatDateTime(post.createdAt)}
                    </span>
                  </div>
                  <div
                    className="rich-text announcement-body"
                    dangerouslySetInnerHTML={{ __html: post.bodyHtml }}
                  />
                </article>
              ))}
            </div>
          )}
        </Card>

        <Card
          className="oij-card"
          title="参赛者"
          extra={
            <Space>
              <span className="muted">共 {participants.length} 人</span>
              <Button
                size="small"
                onClick={() => {
                  setCsvResult(null);
                  setCsvError(null);
                  setCsvModalOpen(true);
                }}
              >
                CSV 导入名单
              </Button>
            </Space>
          }
        >
          <div className="participants-add">
            <Select<number[]>
              mode="multiple"
              showSearch
              optionFilterProp="label"
              placeholder="按用户选择参赛者"
              value={selectedUserIds}
              options={candidateOptions}
              onChange={(value) => setSelectedUserIds(value)}
              loading={usersQuery.isPending}
              style={{ flex: 1, minWidth: 260 }}
            />
            <Button
              type="primary"
              disabled={selectedUserIds.length === 0}
              loading={addingParticipants}
              onClick={() => void addParticipants()}
            >
              添加参赛者
            </Button>
          </div>
          <Table<ContestParticipant>
            className="oij-table"
            rowKey="user_id"
            size="small"
            columns={participantColumns}
            dataSource={participants}
            pagination={false}
            locale={{ emptyText: '还没有参赛者' }}
          />
        </Card>

        <Card
          className="oij-card"
          title="团队报名"
          extra={<span className="muted">共 {teamRegistrations.length} 支</span>}
        >
          <div className="stack">
            {!teamRegistrationEnabled ? (
              <Alert
                type="info"
                showIcon
                message="当前比赛为个人赛，未开放团队报名。"
                description="在“基本信息”中把报名模式改为“团队赛”或“个人/团队均可”后即可添加团队。"
              />
            ) : null}
            <Space wrap>
              <Input
                placeholder="团队 ID 或团队名称"
                value={teamIdentifier}
                disabled={!teamRegistrationEnabled}
                onChange={(event) => setTeamIdentifier(event.target.value)}
                onPressEnter={() => void addTeamRegistration()}
                style={{ width: 280 }}
              />
              <Button
                type="primary"
                loading={addingTeam}
                disabled={!teamRegistrationEnabled || teamIdentifier.trim() === ''}
                onClick={() => void addTeamRegistration()}
              >
                添加团队
              </Button>
              <span className="muted">
                支持精确团队名；不在当前可见团队列表中的团队请直接输入团队 ID。
              </span>
            </Space>
            {contestTeamsQuery.isPending ? (
              <div className="inline-loading">
                <Spin />
              </div>
            ) : contestTeamsQuery.isError ? (
              <ErrorResult
                error={contestTeamsQuery.error}
                onRetry={() => void contestTeamsQuery.refetch()}
              />
            ) : (
              <Table<TeamRegistration>
                className="oij-table"
                rowKey="teamId"
                size="small"
                columns={teamRegistrationColumns}
                dataSource={teamRegistrations}
                pagination={false}
                locale={{ emptyText: '还没有团队报名' }}
              />
            )}
          </div>
        </Card>

        <Card
          className="oij-card"
          title="锁题记录"
          extra={<span className="muted">共 {locksQuery.data?.length ?? 0} 条</span>}
        >
          {locksQuery.isPending ? (
            <div className="inline-loading">
              <Spin />
            </div>
          ) : locksQuery.isError ? (
            <ErrorResult
              error={locksQuery.error}
              onRetry={() => void locksQuery.refetch()}
            />
          ) : (
            <Table<ContestLockRecord>
              className="oij-table"
              rowKey={(row) => `${row.user_id}:${row.problem_id}`}
              size="small"
              columns={lockColumns}
              dataSource={locksQuery.data ?? []}
              pagination={false}
              locale={{ emptyText: '暂无锁定' }}
            />
          )}
        </Card>

        <Card
          className="oij-card"
          title="Hack 审计"
          extra={<span className="muted">{hackAuditStats.total} 条 · 每 10s 刷新</span>}
        >
          <Space wrap size={[8, 8]} style={{ marginBottom: 12 }}>
            <Tag>总 Hack {hackAuditStats.total}</Tag>
            <Tag color="green">成功 {hackAuditStats.success}</Tag>
            <Tag>失败 {hackAuditStats.failed}</Tag>
            <Tag color="orange">非法/无法判定 {hackAuditStats.invalid}</Tag>
            <Tag>已撤销 {hackAuditStats.reverted}</Tag>
            <Select
              size="small"
              value={hackAuditFilter}
              options={[
                { value: 'all', label: '全部' },
                { value: 'success', label: '成功' },
                { value: 'failed', label: '失败' },
                { value: 'invalid', label: '非法/无法判定' },
                { value: 'reverted', label: '已撤销' },
                { value: 'pending', label: '判断中' },
              ]}
              onChange={(value) => setHackAuditFilter(value)}
              style={{ width: 150 }}
            />
          </Space>
          {hackAuditQuery.isPending ? (
            <div className="inline-loading">
              <Spin />
            </div>
          ) : hackAuditQuery.isError ? (
            <ErrorResult
              error={hackAuditQuery.error}
              onRetry={() => void hackAuditQuery.refetch()}
            />
          ) : (
            <Table<HackAuditItem>
              className="oij-table"
              rowKey="id"
              size="small"
              columns={hackAuditColumns}
              dataSource={filteredHackAuditRows}
              pagination={false}
              scroll={{ x: 1180 }}
              locale={{ emptyText: '暂无 Hack 记录' }}
            />
          )}
        </Card>

        <Card
          className="oij-card"
          title="班级统计"
          extra={
            <span className="muted">
              {classStatsQuery.isFetching ? '更新中…' : '按班级汇总比赛成绩'}
            </span>
          }
        >
          {classStatsQuery.isPending ? (
            <PageLoading tip="正在加载班级统计…" />
          ) : classStatsQuery.isError ? (
            <ErrorResult
              error={classStatsQuery.error}
              onRetry={() => void classStatsQuery.refetch()}
            />
          ) : (
            <Table<ClassStatRow>
              className="oij-table"
              rowKey="className"
              size="small"
              columns={classColumns}
              dataSource={classStatsQuery.data ?? []}
              pagination={false}
              locale={{ emptyText: '还没有班级统计数据' }}
            />
          )}
        </Card>
      </div>

      <Modal
        title="CSV 导入参赛名单"
        open={csvModalOpen}
        onCancel={() => setCsvModalOpen(false)}
        okText="导入名单"
        cancelText="取消"
        confirmLoading={importingCsv}
        onOk={() => void importParticipantCsv()}
      >
        <div className="stack">
          <Alert
            type="info"
            showIcon
            message="每行一个已注册用户名；首列作为用户名，支持表头 username。"
          />
          <Input.TextArea
            rows={8}
            value={csvText}
            onChange={(event) => setCsvText(event.target.value)}
            placeholder={'alice\nbob\ncarol,备注'}
          />
          {csvError ? <Alert type="error" showIcon message={csvError} /> : null}
          {csvResult ? (
            <Alert
              type="success"
              showIcon
              message={`新增 ${csvResult.added.length} 人，跳过 ${csvResult.skipped.length} 人，未知 ${csvResult.unknown.length} 人`}
              description={
                <div className="stack">
                  {csvResult.added.length > 0 ? (
                    <span>新增：{csvResult.added.join('、')}</span>
                  ) : null}
                  {csvResult.skipped.length > 0 ? (
                    <span>跳过（已在名单）：{csvResult.skipped.join('、')}</span>
                  ) : null}
                  {csvResult.unknown.length > 0 ? (
                    <span>未知用户：{csvResult.unknown.join('、')}</span>
                  ) : null}
                </div>
              }
            />
          ) : null}
        </div>
      </Modal>
    </div>
  );
}
