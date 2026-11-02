import { useEffect, useRef, useState, type DragEvent } from 'react';
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
  Tabs,
  Tag,
  Tooltip,
} from 'antd';
import type { TableColumnsType } from 'antd';
import {
  CodeOutlined,
  CopyOutlined,
  DeleteOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiDelete, apiGet, apiPost, apiPut, apiUpload } from '../api/client';
import type {
  AdminDataImportResult,
  AdminTestcase,
  AssetKind,
  CompileAssetResult,
  GenerateResult,
  ObjectiveQuestion,
  ProblemAsset,
  ProblemAssetSource,
  ProblemDetail,
  ProblemType,
  SelfTestResult,
  SelfTestTestcaseResult,
  StressResult,
  UpdateProblemRequest,
  ValidateResult,
  ValidateTestcaseResult,
} from '../api/types';
import { CodeBlock } from '../components/CodeBlock';
import { ObjectiveQuestionEditor, validateObjectiveQuestions } from '../components/ObjectiveQuestionEditor';
import { DataPlanPanel } from '../components/DataPlanPanel';
import { PageHead } from '../components/PageHead';
import { ErrorResult, PageLoading } from '../components/PageStates';
import { VerdictBadge } from '../components/VerdictBadge';
import {
  formatBytes,
  formatDateTime,
  formatMemoryKb,
  formatMemoryLimit,
  formatRunTime,
  formatTimeLimit,
} from '../utils/format';
import {
  PROBLEM_TYPE_LABEL,
  difficultyLabel,
  problemTypeLabel,
} from '../utils/status';
import '../styles/admin.css';
import '../styles/objective.css';

const MAX_UPLOAD_BYTES = 80 * 1024 * 1024;
const ALLOWED_SOURCE_ACCEPT = '.cpp,.cc,.cxx,.c,.py,.exe,.txt';

const ASSET_META: Record<AssetKind, { label: string; hint: string }> = {
  std: { label: '标准程序', hint: '标准答案 / std 自测 / 对拍基准，上传后编译为可执行文件。' },
  checker: { label: '校验器', hint: '自定义 SPJ 源码，支持 testlib 或 Lemon 六参数模式。' },
  validator: { label: '输入校验器', hint: '校验输入数据合法性，可在“校验与自测”运行。' },
  generator: {
    label: '数据生成器',
    hint: '接收 argv[1]=seed，向 stdout 输出测试输入；可在“生成与对拍”造数据。',
  },
  interactor: { label: '交互器', hint: '交互题评测器（后续 Phase 接入）。' },
  judger: { label: '自定义评测器', hint: '完整评测流程程序（后续 Phase 接入）。' },
  brute: {
    label: '暴力程序',
    hint: '对拍用暴力程序；在“生成与对拍”中与 std 逐点比较找反例。',
  },
};

const ASSET_ORDER: AssetKind[] = [
  'std',
  'checker',
  'validator',
  'generator',
  'interactor',
  'judger',
  'brute',
];

const TYPE_OPTIONS = (Object.keys(PROBLEM_TYPE_LABEL) as ProblemType[]).map((value) => ({
  value,
  label: PROBLEM_TYPE_LABEL[value],
}));

const CHECKER_MODE_OPTIONS = [
  { value: 'builtin', label: 'builtin（内置精确比较）' },
  { value: 'testlib', label: 'testlib' },
  { value: 'lemon', label: 'lemon 六参数' },
];

const COMPARE_MODE_OPTIONS = [
  { value: 'ignore-trailing', label: 'ignore-trailing（忽略行尾空白）' },
  { value: 'exact', label: 'exact（精确比较）' },
  { value: 'ignore-all', label: 'ignore-all（忽略所有空白）' },
  { value: 'case-insensitive', label: 'case-insensitive（忽略大小写）' },
  { value: 'float', label: 'float（浮点误差 1e-6）' },
];

const VISIBILITY_OPTIONS = [
  { value: 'public', label: '公开' },
  { value: 'hidden', label: '隐藏' },
];

interface BasicFormValues {
  title: string;
  type: ProblemType;
  difficulty?: number | null;
  tags?: string[];
  timeMs: number;
  memoryMb: number;
  ioMode: 'stdio' | 'file';
  inputFile?: string;
  outputFile?: string;
  statementHtml?: string;
  visibility: 'public' | 'hidden';
  checkerMode: 'builtin' | 'testlib' | 'lemon';
  compareMode: string;
}

type KindMap<T> = Partial<Record<AssetKind, T>>;

function describeImportError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'MISSING_OUTPUTS':
        return `缺少输出文件：${error.message}`;
      case 'UNSAFE_PATH':
        return `zip 内含不安全路径：${error.message}`;
      case 'NO_INPUTS':
        return 'zip 内没有 .in 输入文件';
      case 'BAD_ZIP':
        return `无法解析 zip：${error.message}`;
      case 'EMPTY_BODY':
        return 'zip 文件为空';
      case 'PROBLEM_NOT_FOUND':
        return '题目不存在';
      default:
        return error.message;
    }
  }
  return error instanceof Error ? error.message : '导入失败';
}

function describeValidateError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'NO_VALIDATOR':
        return '尚未上传 validator，请先在“程序资产”上传 validator.cpp。';
      case 'BINARY_VALIDATOR':
        return 'validator 必须是源码文件（如 .cpp），不能是二进制。';
      case 'VALIDATOR_COMPILE_FAILED':
        return `validator 编译失败：${error.message}`;
      case 'PROBLEM_NOT_FOUND':
        return '题目不存在';
      default:
        return error.message;
    }
  }
  return error instanceof Error ? error.message : 'validator 运行失败';
}

function describeSelfTestError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'NO_STD':
        return '尚未上传 std，请先在“程序资产”上传 std.cpp。';
      case 'STD_COMPILE_FAILED':
        return `std 编译失败：${error.message}`;
      case 'CHECKER_COMPILE_FAILED':
        return `checker 编译失败：${error.message}`;
      case 'PROBLEM_NOT_FOUND':
        return '题目不存在';
      default:
        return error.message;
    }
  }
  return error instanceof Error ? error.message : 'std 自测运行失败';
}

function describeGenerateError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'GENERATOR':
        return `generator 缺失或编译失败：${error.message}`;
      case 'STD':
        return `std 缺失或编译失败：${error.message}`;
      case 'GENERATE_FAILED':
        return `generator 运行失败：${error.message}`;
      case 'STD_FAILED':
        return `std 运行失败：${error.message}`;
      case 'NOT_FOUND':
        return '题目不存在';
      default:
        return error.message;
    }
  }
  return error instanceof Error ? error.message : '生成测试数据失败';
}

function describeStressError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'GENERATOR':
        return `generator 缺失或编译失败：${error.message}`;
      case 'STD':
        return `std 缺失或编译失败：${error.message}`;
      case 'BRUTE':
        return `brute 缺失或编译失败：${error.message}`;
      case 'GENERATE_FAILED':
        return `generator 运行失败：${error.message}`;
      case 'STRESS_FAILED':
        return `对拍失败：${error.message}`;
      case 'NOT_FOUND':
        return '题目不存在';
      default:
        return error.message;
    }
  }
  return error instanceof Error ? error.message : '对拍失败';
}

function OutputBlock({ title, content }: { title: string; content: string }) {
  const { message } = App.useApp();
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      message.success('已复制');
    } catch {
      message.error('复制失败，请手动选择文本');
    }
  };
  return (
    <div className="tool-output">
      <div className="tool-output-head">
        <span>{title}</span>
        <Button size="small" type="text" icon={<CopyOutlined />} onClick={() => void handleCopy()}>
          复制
        </Button>
      </div>
      <pre className="tool-pre">{content.length > 0 ? content : '（空）'}</pre>
    </div>
  );
}

function toBasicFormValues(problem: ProblemDetail): BasicFormValues {
  return {
    title: problem.title,
    type: problem.type,
    difficulty: problem.difficulty,
    tags: problem.tags,
    timeMs: problem.timeMs,
    memoryMb: problem.memoryMb,
    ioMode: problem.ioMode,
    inputFile: problem.inputFile ?? '',
    outputFile: problem.outputFile ?? '',
    statementHtml: problem.statementHtml,
    visibility: problem.visibility,
    checkerMode: problem.checkerMode,
    compareMode: problem.compareMode,
  };
}

export function AdminProblemPage() {
  const params = useParams<{ problemId: string }>();
  const problemId = Number(params.problemId);
  const validId = Number.isInteger(problemId) && problemId > 0;
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState('basic');
  const [basicForm] = Form.useForm<BasicFormValues>();
  const basicIoMode = Form.useWatch('ioMode', basicForm);
  const basicType = Form.useWatch('type', basicForm);
  const [objectiveDraft, setObjectiveDraft] = useState<ObjectiveQuestion[]>([]);
  const [savingObjective, setSavingObjective] = useState(false);
  const [exporting, setExporting] = useState<'oi' | 'cena' | 'lemon' | null>(null);
  const objectiveInitializedRef = useRef(false);
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState<ValidateResult | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [selfTesting, setSelfTesting] = useState(false);
  const [selfTestResult, setSelfTestResult] = useState<SelfTestResult | null>(null);
  const [selfTestError, setSelfTestError] = useState<string | null>(null);
  const [generateCount, setGenerateCount] = useState<number>(2);
  const [generateSeedStart, setGenerateSeedStart] = useState<number>(1);
  const [generatePoints, setGeneratePoints] = useState<number>(100);
  const [generating, setGenerating] = useState(false);
  const [generateResult, setGenerateResult] = useState<GenerateResult | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [stressRounds, setStressRounds] = useState<number>(20);
  const [stressSeedStart, setStressSeedStart] = useState<number>(1);
  const [stressing, setStressing] = useState(false);
  const [stressResult, setStressResult] = useState<StressResult | null>(null);
  const [stressError, setStressError] = useState<string | null>(null);

  const [uploading, setUploading] = useState<KindMap<boolean>>({});
  const [compiling, setCompiling] = useState<KindMap<boolean>>({});
  const [deleting, setDeleting] = useState<KindMap<boolean>>({});
  const [compileResults, setCompileResults] = useState<KindMap<CompileAssetResult>>({});
  const [checkerMode, setCheckerMode] = useState<'testlib' | 'lemon'>('testlib');
  const fileInputs = useRef<Partial<Record<AssetKind, HTMLInputElement | null>>>({});

  const [sourceOpen, setSourceOpen] = useState(false);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceKind, setSourceKind] = useState<AssetKind>('std');
  const [sourceName, setSourceName] = useState('');
  const [sourceText, setSourceText] = useState('');
  const [sourceError, setSourceError] = useState<string | null>(null);

  const [zipFile, setZipFile] = useState<File | null>(null);
  const [importPoints, setImportPoints] = useState<number>(100);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<AdminDataImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const zipInputRef = useRef<HTMLInputElement | null>(null);

  const [pointsDraft, setPointsDraft] = useState<Record<number, number>>({});
  const [savingPoints, setSavingPoints] = useState(false);

  const problemQuery = useQuery({
    queryKey: ['admin-problem', problemId],
    queryFn: () => apiGet<ProblemDetail>(`/api/admin/problems/${problemId}`),
    enabled: validId,
  });
  const assetsQuery = useQuery({
    queryKey: ['admin-assets', problemId],
    queryFn: () => apiGet<ProblemAsset[]>(`/api/admin/problems/${problemId}/assets`),
    enabled: validId,
  });
  const testcasesQuery = useQuery({
    queryKey: ['admin-testcases', problemId],
    queryFn: () => apiGet<AdminTestcase[]>(`/api/admin/problems/${problemId}/testcases`),
    enabled: validId,
  });

  const problem = problemQuery.data ?? null;
  const isObjective = (basicType ?? problem?.type) === 'objective';
  const isOutputOnly = (basicType ?? problem?.type) === 'output-only';

  useEffect(() => {
    if (!problem) return;
    basicForm.setFieldsValue(toBasicFormValues(problem));
  }, [basicForm, problem]);

  useEffect(() => {
    if (!problem) return;
    setObjectiveDraft(
      (problem.objective?.questions ?? []).map((question) => ({
        ...question,
        options: question.options?.map((option) => ({ ...option })),
        answers: [...(question.answers ?? [])],
      })),
    );
  }, [problem]);

  useEffect(() => {
    if (problem?.type !== 'objective' || objectiveInitializedRef.current) return;
    objectiveInitializedRef.current = true;
    setActiveTab('objective');
  }, [problem?.type]);

  useEffect(() => {
    if (isObjective && activeTab !== 'basic' && activeTab !== 'objective') {
      setActiveTab('objective');
    } else if (!isObjective && activeTab === 'objective') {
      setActiveTab('basic');
    }
  }, [activeTab, isObjective]);

  useEffect(() => {
    const mode = problemQuery.data?.checkerMode;
    if (mode === 'testlib' || mode === 'lemon') {
      setCheckerMode(mode);
    }
  }, [problemQuery.data?.checkerMode]);

  useEffect(() => {
    if (!testcasesQuery.data) return;
    setPointsDraft(
      Object.fromEntries(testcasesQuery.data.map((row) => [row.id, row.points])),
    );
  }, [testcasesQuery.data]);

  const invalidateAssets = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin-assets', problemId] });
  };

  const uploadAsset = async (kind: AssetKind, file: File) => {
    if (file.size > MAX_UPLOAD_BYTES) {
      message.error('文件超过 80 MB 限制');
      return;
    }
    setUploading((previous) => ({ ...previous, [kind]: true }));
    try {
      const search = new URLSearchParams({ name: file.name });
      if (kind === 'checker') search.set('mode', checkerMode);
      await apiUpload<ProblemAsset>(
        `/api/admin/problems/${problemId}/assets/${kind}?${search.toString()}`,
        file,
        'application/octet-stream',
      );
      message.success(`${ASSET_META[kind].label}已上传`);
      setCompileResults((previous) => {
        const next = { ...previous };
        delete next[kind];
        return next;
      });
      invalidateAssets();
      if (kind === 'checker') {
        void queryClient.invalidateQueries({ queryKey: ['admin-problem', problemId] });
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : '上传失败');
    } finally {
      setUploading((previous) => ({ ...previous, [kind]: false }));
    }
  };

  const compileAsset = async (kind: AssetKind) => {
    setCompiling((previous) => ({ ...previous, [kind]: true }));
    try {
      const result = await apiPost<CompileAssetResult>(
        `/api/admin/problems/${problemId}/assets/${kind}/compile`,
      );
      setCompileResults((previous) => ({ ...previous, [kind]: result }));
      if (result.compiled) {
        message.success(result.cached ? '编译成功（缓存命中）' : '编译成功');
      } else {
        message.error('编译失败');
      }
    } catch (error) {
      const result: CompileAssetResult = {
        compiled: false,
        message: error instanceof Error ? error.message : '编译请求失败',
      };
      setCompileResults((previous) => ({ ...previous, [kind]: result }));
      message.error(result.message);
    } finally {
      setCompiling((previous) => ({ ...previous, [kind]: false }));
    }
  };

  const openSource = async (kind: AssetKind) => {
    setSourceOpen(true);
    setSourceLoading(true);
    setSourceKind(kind);
    setSourceName('');
    setSourceText('');
    setSourceError(null);
    try {
      const data = await apiGet<ProblemAssetSource>(
        `/api/admin/problems/${problemId}/assets/${kind}/source`,
      );
      setSourceName(data.name);
      setSourceText(data.source);
    } catch (error) {
      setSourceError(error instanceof Error ? error.message : '读取源码失败');
    } finally {
      setSourceLoading(false);
    }
  };

  const removeAsset = async (kind: AssetKind) => {
    setDeleting((previous) => ({ ...previous, [kind]: true }));
    try {
      await apiDelete<null>(`/api/admin/problems/${problemId}/assets/${kind}`);
      message.success(`${ASSET_META[kind].label}已删除`);
      setCompileResults((previous) => {
        const next = { ...previous };
        delete next[kind];
        return next;
      });
      invalidateAssets();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '删除失败');
    } finally {
      setDeleting((previous) => ({ ...previous, [kind]: false }));
    }
  };

  const handleAssetDrop = (event: DragEvent<HTMLDivElement>, kind: AssetKind) => {
    event.preventDefault();
    const file = event.dataTransfer.files?.[0];
    if (file) void uploadAsset(kind, file);
  };

  const importData = async () => {
    if (!zipFile) {
      message.warning('请选择 zip 文件');
      return;
    }
    setImporting(true);
    setImportError(null);
    try {
      const result = await apiUpload<AdminDataImportResult>(
        `/api/admin/problems/${problemId}/data/import?points=${encodeURIComponent(
          String(importPoints),
        )}`,
        zipFile,
        'application/zip',
      );
      setImportResult(result);
      setZipFile(null);
      if (zipInputRef.current) zipInputRef.current.value = '';
      message.success(`已导入 ${result.testcases.length} 个测试点`);
      void queryClient.invalidateQueries({ queryKey: ['admin-testcases', problemId] });
    } catch (error) {
      const text = describeImportError(error);
      setImportError(text);
      message.error(text);
    } finally {
      setImporting(false);
    }
  };

  const testcases = testcasesQuery.data ?? [];
  const pointsDirty = testcases.some(
    (row) => (pointsDraft[row.id] ?? row.points) !== row.points,
  );
  const totalDraftPoints = testcases.reduce(
    (sum, row) => sum + (pointsDraft[row.id] ?? row.points),
    0,
  );

  const savePoints = async () => {
    const items = testcases.map((row) => ({
      id: row.id,
      points: Number(pointsDraft[row.id] ?? row.points),
    }));
    if (items.some((item) => !Number.isFinite(item.points) || item.points < 0)) {
      message.error('分值必须是非负数字');
      return;
    }
    setSavingPoints(true);
    try {
      await apiPut<null>(`/api/admin/problems/${problemId}/testcases`, { items });
      message.success('测试点分值已保存');
      void queryClient.invalidateQueries({ queryKey: ['admin-testcases', problemId] });
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存分值失败');
    } finally {
      setSavingPoints(false);
    }
  };

  const updateProblemMutation = useMutation({
    mutationFn: (values: BasicFormValues) => {
      const payload: UpdateProblemRequest = {
        title: values.title.trim(),
        type: values.type,
        difficulty: typeof values.difficulty === 'number' ? values.difficulty : null,
        tags: (values.tags ?? []).map((tag) => tag.trim()).filter((tag) => tag.length > 0),
        timeMs: Number(values.timeMs),
        memoryMb: Number(values.memoryMb),
        ioMode: values.ioMode,
        inputFile: values.ioMode === 'file' ? (values.inputFile ?? '').trim() : null,
        outputFile: values.ioMode === 'file' ? (values.outputFile ?? '').trim() : null,
        statementHtml: values.statementHtml ?? '',
        visibility: values.visibility,
        checkerMode: values.checkerMode,
        compareMode: values.compareMode,
        ...(values.type === 'objective'
          ? { objective: { questions: objectiveDraft } }
          : {}),
      };
      return apiPut<{ id: number }>(`/api/admin/problems/${problemId}`, payload);
    },
    onSuccess: () => {
      message.success('题目基础信息已保存');
      void queryClient.invalidateQueries({ queryKey: ['admin-problem', problemId] });
      void queryClient.invalidateQueries({ queryKey: ['admin-problems'] });
      void queryClient.invalidateQueries({ queryKey: ['problems'] });
    },
    onError: (error) => {
      message.error(error instanceof Error ? error.message : '保存失败');
    },
  });

  const resetBasicForm = () => {
    if (!problem) return;
    basicForm.setFieldsValue(toBasicFormValues(problem));
  };

  const saveObjective = async () => {
    const error = validateObjectiveQuestions(objectiveDraft);
    if (error) {
      message.error(error);
      return;
    }
    const questions = objectiveDraft.map((question) => ({
      id: question.id,
      kind: question.kind,
      stem: question.stem.trim(),
      points: Number(question.points),
      answers:
        question.kind === 'fill'
          ? (question.answers ?? []).map((answer) => answer.trim()).filter((answer) => answer.length > 0)
          : [...(question.answers ?? [])],
      ...(question.kind === 'single' || question.kind === 'multiple'
        ? {
            options: (question.options ?? []).map((option) => ({
              key: option.key.trim(),
              text: option.text.trim(),
            })),
          }
        : {}),
      ...(question.kind === 'multiple' ? { partial: question.partial === true } : {}),
      ...(question.kind === 'fill'
        ? {
            ignoreCase: question.ignoreCase !== false,
            ignoreWhitespace: question.ignoreWhitespace !== false,
          }
        : {}),
    }));
    setSavingObjective(true);
    try {
      await apiPut<{ id: number }>(`/api/admin/problems/${problemId}`, {
        objective: { questions },
      });
      message.success('客观题配置已保存');
      void queryClient.invalidateQueries({ queryKey: ['admin-problem', problemId] });
      void queryClient.invalidateQueries({ queryKey: ['admin-problems'] });
      void queryClient.invalidateQueries({ queryKey: ['problems'] });
    } catch (saveError) {
      message.error(saveError instanceof Error ? saveError.message : '保存客观题失败');
    } finally {
      setSavingObjective(false);
    }
  };

  const downloadProblemExport = async (format: 'oi' | 'cena' | 'lemon') => {
    setExporting(format);
    try {
      const endpoint =
        format === 'cena' ? 'export-cena' : format === 'lemon' ? 'export-lemon' : 'export';
      const response = await fetch(`/api/admin/problems/${problemId}/${endpoint}`, {
        credentials: 'include',
      });
      if (!response.ok) {
        message.error(
          format === 'cena'
            ? '导出 Cena 题包失败'
            : format === 'lemon'
              ? '导出 Lemon 题包失败'
              : '导出 OI 题包失败',
        );
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download =
        format === 'cena'
          ? `cena-${problemId}.zip`
          : format === 'lemon'
            ? `lemon-${problemId}.zip`
            : `problem-${problemId}.zip`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      message.success(
        format === 'cena'
          ? 'Cena 题包已导出'
          : format === 'lemon'
            ? 'Lemon 题包已导出'
            : 'OI 题包已导出',
      );
    } catch (error) {
      message.error(error instanceof Error ? error.message : '导出失败');
    } finally {
      setExporting(null);
    }
  };

  const runValidation = async () => {
    setValidating(true);
    setValidationError(null);
    try {
      const result = await apiPost<ValidateResult>(
        `/api/admin/problems/${problemId}/validate`,
      );
      setValidationResult(result);
      if (result.total === 0) {
        message.warning('没有测试数据，validator 未执行');
      } else if (result.passed === result.total) {
        message.success(`validator 全部通过（${result.passed}/${result.total}）`);
      } else {
        message.warning(`validator ${result.passed}/${result.total} 通过`);
      }
    } catch (error) {
      const text = describeValidateError(error);
      setValidationError(text);
      setValidationResult(null);
      message.error(text);
    } finally {
      setValidating(false);
    }
  };

  const runSelfTest = async () => {
    setSelfTesting(true);
    setSelfTestError(null);
    try {
      const result = await apiPost<SelfTestResult>(
        `/api/admin/problems/${problemId}/self-test`,
      );
      setSelfTestResult(result);
      if (result.results.length === 0) {
        message.warning('没有测试数据，std 自测未执行');
      } else if (result.results.every((item) => item.verdict === 'AC')) {
        message.success(`std 自测全部 AC，总分 ${result.score}`);
      } else {
        message.warning(`std 自测得分 ${result.score}`);
      }
    } catch (error) {
      const text = describeSelfTestError(error);
      setSelfTestError(text);
      setSelfTestResult(null);
      message.error(text);
    } finally {
      setSelfTesting(false);
    }
  };

  const runGenerate = async () => {
    setGenerating(true);
    setGenerateError(null);
    try {
      const result = await apiPost<GenerateResult>(
        `/api/admin/problems/${problemId}/generate`,
        {
          count: generateCount,
          seedStart: generateSeedStart,
          points: generatePoints,
        },
      );
      setGenerateResult(result);
      message.success(`已生成并追加 ${result.generated.length} 个测试点`);
      void queryClient.invalidateQueries({ queryKey: ['admin-testcases', problemId] });
    } catch (error) {
      const text = describeGenerateError(error);
      setGenerateError(text);
      setGenerateResult(null);
      message.error(text);
    } finally {
      setGenerating(false);
    }
  };

  const runStress = async () => {
    setStressing(true);
    setStressError(null);
    try {
      const result = await apiPost<StressResult>(
        `/api/admin/problems/${problemId}/stress`,
        { rounds: stressRounds, seedStart: stressSeedStart },
      );
      setStressResult(result);
      if (result.mismatch) {
        message.warning(`发现反例：seed ${result.mismatch.seed}`);
      } else {
        message.success(`未发现反例，通过 ${result.passed}/${result.total}`);
      }
    } catch (error) {
      const text = describeStressError(error);
      setStressError(text);
      setStressResult(null);
      message.error(text);
    } finally {
      setStressing(false);
    }
  };

  if (!validId) {
    return <ErrorResult error={new Error('无效的题目编号')} />;
  }
  if (problemQuery.isPending) {
    return <PageLoading tip="正在加载题目…" />;
  }
  if (problemQuery.isError) {
    return (
      <ErrorResult error={problemQuery.error} onRetry={() => void problemQuery.refetch()} />
    );
  }
  if (!problem) {
    return <PageLoading tip="正在加载题目…" />;
  }

  const assetsById = new Map((assetsQuery.data ?? []).map((asset) => [asset.kind, asset]));

  const basicPanel = (
    <Card
      className="oij-card"
      title="基本信息"
      extra={
        <Space>
          <Button onClick={resetBasicForm}>重置</Button>
          <Button
            type="primary"
            loading={updateProblemMutation.isPending}
            onClick={() => basicForm.submit()}
          >
            保存
          </Button>
        </Space>
      }
    >
      {isObjective ? (
        <Alert
          className="objective-info-alert"
          type="info"
          showIcon
          message="客观题不使用程序资产与测试数据"
          description="请在“客观题”Tab 中维护题目、选项、正确答案和分值；比赛中的题目分值需与客观题总分一致。"
        />
      ) : null}
      {isOutputOnly ? (
        <Alert
          className="objective-info-alert"
          type="info"
          showIcon
          message="提交答案题无需 std / checker"
          description="选手下载每个测试点的输入并提交输出；测试数据仍需在“测试数据”Tab 导入 .in/.out，导入后的测试点分值之和即题目总分。"
        />
      ) : null}
      <Form<BasicFormValues>
        form={basicForm}
        layout="vertical"
        requiredMark={false}
        onFinish={(values) => updateProblemMutation.mutate(values)}
      >
        <Row gutter={12}>
          <Col span={16}>
            <Form.Item
              label="标题"
              name="title"
              rules={[{ required: true, message: '请输入题目标题' }]}
            >
              <Input maxLength={120} showCount />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item label="题目 ID">
              <Input value={`#${problem.id}`} disabled />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={12}>
          <Col span={8}>
            <Form.Item label="类型" name="type" rules={[{ required: true, message: '请选择类型' }]}>
              <Select options={TYPE_OPTIONS} />
            </Form.Item>
          </Col>
          <Col span={5}>
            <Form.Item
              label="时间限制 (ms)"
              name="timeMs"
              rules={[{ required: true, message: '请输入时限' }]}
            >
              <InputNumber min={1} precision={0} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={5}>
            <Form.Item
              label="内存限制 (MB)"
              name="memoryMb"
              rules={[{ required: true, message: '请输入内存' }]}
            >
              <InputNumber min={1} precision={0} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item
              label="难度（1-6）"
              name="difficulty"
              extra="留空保存为 null"
            >
              <InputNumber min={1} max={6} precision={0} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={12}>
          <Col span={12}>
            <Form.Item label="标签" name="tags">
              <Select mode="tags" tokenSeparators={[',', ' ']} placeholder="输入后回车" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              label="可见性"
              name="visibility"
              rules={[{ required: true, message: '请选择可见性' }]}
              extra="隐藏题不会出现在公开题库与题目列表"
            >
              <Select options={VISIBILITY_OPTIONS} />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={12}>
          <Col span={6}>
            <Form.Item
              label="IO 模式"
              name="ioMode"
              rules={[{ required: true, message: '请选择 IO 模式' }]}
            >
              <Select
                options={[
                  { value: 'stdio', label: '标准输入输出' },
                  { value: 'file', label: '文件 IO' },
                ]}
              />
            </Form.Item>
          </Col>
          {basicIoMode === 'file' ? (
            <>
              <Col span={9}>
                <Form.Item
                  label="输入文件名"
                  name="inputFile"
                  rules={[{ required: true, message: '请输入输入文件名' }]}
                >
                  <Input placeholder="例如 input.txt" />
                </Form.Item>
              </Col>
              <Col span={9}>
                <Form.Item
                  label="输出文件名"
                  name="outputFile"
                  rules={[{ required: true, message: '请输入输出文件名' }]}
                >
                  <Input placeholder="例如 output.txt" />
                </Form.Item>
              </Col>
            </>
          ) : null}
        </Row>

        <Row gutter={12}>
          <Col span={12}>
            <Form.Item
              label="Checker 模式"
              name="checkerMode"
              rules={[{ required: true, message: '请选择 checker 模式' }]}
            >
              <Select options={CHECKER_MODE_OPTIONS} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              label="比较模式"
              name="compareMode"
              rules={[{ required: true, message: '请选择比较模式' }]}
            >
              <Select options={COMPARE_MODE_OPTIONS} />
            </Form.Item>
          </Col>
        </Row>

        <Form.Item
          label="题面（Markdown / HTML）"
          name="statementHtml"
          extra="支持 Markdown、$...$ / $$...$$ LaTeX 和安全的 HTML；旧 HTML 题面仍兼容。"
        >
          <Input.TextArea rows={10} placeholder={'<h1>题目名称</h1>\n<p>题目描述……</p>'} />
        </Form.Item>

        <div className="basic-form-footer muted">
          {isObjective
            ? `客观题共 ${objectiveDraft.length} 题 · 总分 ${objectiveDraft.reduce(
                (sum, question) => sum + Number(question.points || 0),
                0,
              )} 分 · 不需要测试数据`
            : `测试点：${testcases.length > 0 ? `${testcases.length} 个` : '尚未导入'} ·
          保存后详情与公开题目列表会刷新`}
        </div>
      </Form>
    </Card>
  );

  const objectivePanel = (
    <Card
      className="oij-card"
      title="客观题"
      extra={
        <Space>
          <span className="muted">
            {objectiveDraft.length} 题 · 总分{' '}
            {objectiveDraft.reduce((sum, question) => sum + Number(question.points || 0), 0)}
          </span>
          <Button
            type="primary"
            loading={savingObjective}
            onClick={() => void saveObjective()}
          >
            保存客观题
          </Button>
        </Space>
      }
    >
      <Alert
        className="objective-info-alert"
        type="info"
        showIcon
        message="客观题不需要程序资产或测试数据"
        description="每题对应一个 test_results 记录；多选可设置部分给分，填空可忽略大小写/空白。保存后选手端即时生效。"
      />
      <ObjectiveQuestionEditor
        questions={objectiveDraft}
        onChange={setObjectiveDraft}
        disabled={savingObjective}
      />
    </Card>
  );

  const assetsPanel = (
    <Card
      className="oij-card"
      title="程序资产"
      extra={
        <span className="muted">
          当前 SPJ：{problem.checkerMode === 'builtin' ? 'builtin（内置比较）' : problem.checkerMode}
          {' · '}每个类型只保留最新一份，重新上传会覆盖
        </span>
      }
    >
      {isOutputOnly ? (
        <Alert
          className="objective-info-alert"
          type="info"
          showIcon
          message="提交答案题不需要 std / checker 资产"
          description="本题由选手直接提交每个测试点的输出；仍可在“测试数据”Tab 导入/调整 .in/.out。"
        />
      ) : null}
      {assetsQuery.isPending ? (
        <div className="inline-loading">
          <Spin />
        </div>
      ) : assetsQuery.isError ? (
        <ErrorResult error={assetsQuery.error} onRetry={() => void assetsQuery.refetch()} />
      ) : (
        <div className="asset-grid">
          {ASSET_ORDER.map((kind) => {
            const meta = ASSET_META[kind];
            const asset = assetsById.get(kind);
            const compileResult = compileResults[kind];
            const busy = Boolean(uploading[kind] || compiling[kind] || deleting[kind]);
            return (
              <Card
                key={kind}
                size="small"
                className="asset-card"
                title={
                  <span className="asset-title">
                    {meta.label}
                    <span className="asset-kind mono">{kind}</span>
                  </span>
                }
                extra={asset ? <Tag color="green">已上传</Tag> : <Tag>未上传</Tag>}
              >
                <div className="asset-hint">{meta.hint}</div>

                {asset ? (
                  <div className="asset-meta">
                    <div>
                      <span className="muted">文件</span>{' '}
                      <span className="mono asset-name" title={asset.name}>
                        {asset.name}
                      </span>
                    </div>
                    <div>
                      <span className="muted">大小</span> {formatBytes(asset.size)}
                    </div>
                    <div>
                      <span className="muted">SHA256</span>{' '}
                      <Tooltip title={asset.sha256}>
                        <span className="mono">{asset.sha256.slice(0, 12)}…</span>
                      </Tooltip>
                    </div>
                    <div>
                      <span className="muted">更新</span> {formatDateTime(asset.updated_at)}
                    </div>
                  </div>
                ) : null}

                {kind === 'checker' ? (
                  <div className="asset-mode">
                    <span className="muted">SPJ 模式</span>
                    <Select
                      size="small"
                      value={checkerMode}
                      onChange={(value: 'testlib' | 'lemon') => setCheckerMode(value)}
                      options={[
                        { value: 'testlib', label: 'testlib' },
                        { value: 'lemon', label: 'lemon 六参数' },
                      ]}
                      style={{ width: 128 }}
                      disabled={busy}
                    />
                  </div>
                ) : null}

                {asset ? (
                  <Space wrap size={8} className="asset-actions">
                    <Button
                      size="small"
                      icon={<CodeOutlined />}
                      onClick={() => void openSource(kind)}
                    >
                      查看源码
                    </Button>
                    <Button
                      size="small"
                      icon={<PlayCircleOutlined />}
                      loading={Boolean(compiling[kind])}
                      onClick={() => void compileAsset(kind)}
                    >
                      编译
                    </Button>
                    <Popconfirm
                      title={`删除${meta.label}？`}
                      description="会同时删除已上传的源文件，且不可恢复。"
                      okText="删除"
                      cancelText="取消"
                      onConfirm={() => void removeAsset(kind)}
                    >
                      <Button
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        loading={Boolean(deleting[kind])}
                      >
                        删除
                      </Button>
                    </Popconfirm>
                  </Space>
                ) : null}

                {compileResult ? (
                  <Alert
                    className="asset-compile"
                    type={compileResult.compiled ? 'success' : 'error'}
                    showIcon
                    message={
                      compileResult.compiled
                        ? `编译成功${compileResult.cached ? '（缓存命中）' : ''}`
                        : '编译失败'
                    }
                    description={compileResult.message || undefined}
                  />
                ) : null}

                <div
                  className={`asset-drop${uploading[kind] ? ' asset-drop-busy' : ''}`}
                  role="button"
                  tabIndex={0}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => handleAssetDrop(event, kind)}
                  onClick={() => fileInputs.current[kind]?.click()}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      fileInputs.current[kind]?.click();
                    }
                  }}
                >
                  {uploading[kind] ? (
                    <Spin size="small" />
                  ) : (
                    <span>{asset ? '拖拽或点击替换文件' : '拖拽或点击上传文件'}</span>
                  )}
                  <span className="asset-drop-hint muted">
                    .cpp / .cc / .cxx / .c / .py / .exe / .txt（≤ 80 MB）
                  </span>
                </div>
                <input
                  ref={(element) => {
                    fileInputs.current[kind] = element;
                  }}
                  className="admin-file-input"
                  type="file"
                  accept={ALLOWED_SOURCE_ACCEPT}
                  data-testid={`asset-input-${kind}`}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void uploadAsset(kind, file);
                    event.target.value = '';
                  }}
                />
              </Card>
            );
          })}
        </div>
      )}
    </Card>
  );

  const testcaseColumns: TableColumnsType<AdminTestcase> = [
    {
      title: '#',
      dataIndex: 'ordinal',
      width: 56,
      render: (value: number) => <span className="mono">{value}</span>,
    },
    {
      title: '输入',
      dataIndex: 'input_path',
      render: (value: string) => (
        <span className="mono data-path" title={value}>
          {value}
        </span>
      ),
    },
    {
      title: '输出',
      dataIndex: 'output_path',
      render: (value: string) => (
        <span className="mono data-path" title={value}>
          {value}
        </span>
      ),
    },
    {
      title: '分值',
      width: 128,
      render: (_value, row) => (
        <InputNumber
          size="small"
          min={0}
          max={10000}
          precision={0}
          value={pointsDraft[row.id] ?? row.points}
          onChange={(value) =>
            setPointsDraft((previous) => ({
              ...previous,
              [row.id]: typeof value === 'number' ? value : 0,
            }))
          }
          style={{ width: 96 }}
        />
      ),
    },
    {
      title: '子任务',
      dataIndex: 'subtask_id',
      width: 88,
      render: (value: number | null) =>
        value === null ? <span className="muted">—</span> : <span className="mono">#{value}</span>,
    },
    {
      title: '依赖',
      dataIndex: 'depends_on',
      width: 90,
      render: (value: string | null) =>
        value ? <span className="mono">{value}</span> : <span className="muted">—</span>,
    },
    {
      title: '状态',
      dataIndex: 'enabled',
      width: 76,
      render: (value: number) =>
        value === 1 ? <Tag color="green">启用</Tag> : <Tag>禁用</Tag>,
    },
  ];

  const dataPanel = (
    <div className="stack">
      <Card className="oij-card" title="导入测试数据（zip）">
        <Alert
          className="data-import-note"
          type="warning"
          showIcon
          message="导入会替换该题现有测试点。zip 内按同名 .in / .out（或 .ans）配对。"
        />
        <div className="zip-upload">
          <input
            ref={zipInputRef}
            type="file"
            accept=".zip,application/zip"
            data-testid="zip-input"
            onChange={(event) => {
              const file = event.target.files?.[0] ?? null;
              setZipFile(file);
              setImportResult(null);
              setImportError(null);
            }}
          />
          <span className="muted">
            {zipFile ? `${zipFile.name} · ${formatBytes(zipFile.size)}` : '尚未选择 zip 文件'}
          </span>
          <span className="zip-points">
            <span className="muted">导入分值</span>
            <InputNumber
              size="small"
              min={1}
              max={10000}
              precision={0}
              value={importPoints}
              onChange={(value) => setImportPoints(typeof value === 'number' ? value : 100)}
              style={{ width: 100 }}
            />
          </span>
          <Button type="primary" loading={importing} onClick={() => void importData()}>
            上传并导入
          </Button>
        </div>
        {importResult ? (
          <Alert
            className="data-import-result"
            type="success"
            showIcon
            message={`导入成功，共 ${importResult.testcases.length} 组测试点`}
            description={importResult.testcases
              .map((testcase) => testcase.stem)
              .join('、')}
          />
        ) : null}
        {importError ? (
          <Alert
            className="data-import-result"
            type="error"
            showIcon
            message="导入失败"
            description={importError}
          />
        ) : null}
      </Card>

      <Card
        className="oij-card"
        title="测试点列表"
        extra={
          <Space>
            <span className="muted">
              共 {testcases.length} 个 · 总分 {totalDraftPoints}
            </span>
            <Button
              size="small"
              icon={<ReloadOutlined />}
              onClick={() => void testcasesQuery.refetch()}
              loading={testcasesQuery.isFetching}
            >
              刷新
            </Button>
            <Button
              size="small"
              type="primary"
              disabled={!pointsDirty}
              loading={savingPoints}
              onClick={() => void savePoints()}
            >
              保存分值
            </Button>
          </Space>
        }
      >
        {testcasesQuery.isPending ? (
          <div className="inline-loading">
            <Spin />
          </div>
        ) : testcasesQuery.isError ? (
          <ErrorResult
            error={testcasesQuery.error}
            onRetry={() => void testcasesQuery.refetch()}
          />
        ) : testcases.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="尚未导入测试数据，请上传 zip"
          />
        ) : (
          <Table<AdminTestcase>
            className="oij-table"
            rowKey="id"
            size="small"
            columns={testcaseColumns}
            dataSource={testcases}
            pagination={false}
            scroll={{ x: 900 }}
          />
        )}
      </Card>
    </div>
  );

  const generatorAsset = assetsById.get('generator');
  const bruteAsset = assetsById.get('brute');
  const toolStdAsset = assetsById.get('std');
  const missingGenerateAssets = [
    generatorAsset?.language ? null : 'generator',
    toolStdAsset?.language ? null : 'std',
  ].filter((item): item is string => item !== null);
  const missingStressAssets = [
    generatorAsset?.language ? null : 'generator',
    toolStdAsset?.language ? null : 'std',
    bruteAsset?.language ? null : 'brute',
  ].filter((item): item is string => item !== null);

  const toolsPanel = (
    <div className="tool-grid">
      <Card
        className="oij-card"
        title="生成测试数据"
        extra={<span className="muted">generator argv[1]=seed → stdout 输入</span>}
      >
        <div className="tool-hint muted">
          generator 按 seed 生成输入、std 生成答案；成功后追加到测试点列表。
        </div>
        <div className="tool-form">
          <label className="tool-field">
            <span className="muted">数量</span>
            <InputNumber
              min={1}
              max={100}
              precision={0}
              value={generateCount}
              onChange={(value) => setGenerateCount(typeof value === 'number' ? value : 1)}
              style={{ width: 100 }}
            />
          </label>
          <label className="tool-field">
            <span className="muted">起始 seed</span>
            <InputNumber
              precision={0}
              value={generateSeedStart}
              onChange={(value) => setGenerateSeedStart(typeof value === 'number' ? value : 1)}
              style={{ width: 100 }}
            />
          </label>
          <label className="tool-field">
            <span className="muted">每题分值</span>
            <InputNumber
              min={1}
              precision={0}
              value={generatePoints}
              onChange={(value) => setGeneratePoints(typeof value === 'number' ? value : 1)}
              style={{ width: 100 }}
            />
          </label>
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            loading={generating}
            onClick={() => void runGenerate()}
          >
            生成并追加
          </Button>
        </div>
        {missingGenerateAssets.length > 0 ? (
          <Alert
            className="tool-alert"
            type="warning"
            showIcon
            message="缺少生成所需资产"
            description={`请先在“程序资产”上传并编译 ${missingGenerateAssets.join('、')}。点击生成仍可查看后端错误。`}
          />
        ) : null}
        {generateError ? (
          <Alert
            className="tool-alert"
            type="error"
            showIcon
            message="生成测试数据失败"
            description={generateError}
          />
        ) : null}
        {generateResult ? (
          <div className="tool-result">
            <Alert
              type="success"
              showIcon
              message={`已生成 ${generateResult.generated.length} 条，测试点总数 ${generateResult.total}`}
              description="测试点已追加到“测试数据”Tab。"
            />
            <div className="tool-seed-list">
              {generateResult.generated.map((item) => (
                <div className="tool-seed-row" key={item.seed}>
                  <span className="mono">seed {item.seed}</span>
                  <span className="mono tool-seed-path">{item.input}</span>
                  <span className="mono tool-seed-path">{item.output}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </Card>

      <Card
        className="oij-card"
        title="std / brute 对拍"
        extra={<span className="muted">首反例保存到 problems/:id/stress/</span>}
      >
        <div className="tool-hint muted">
          逐 seed 生成输入，分别运行 std 与 brute；输出不一致即保存为首个反例。
        </div>
        <div className="tool-form">
          <label className="tool-field">
            <span className="muted">轮数</span>
            <InputNumber
              min={1}
              max={1000}
              precision={0}
              value={stressRounds}
              onChange={(value) => setStressRounds(typeof value === 'number' ? value : 1)}
              style={{ width: 100 }}
            />
          </label>
          <label className="tool-field">
            <span className="muted">起始 seed</span>
            <InputNumber
              precision={0}
              value={stressSeedStart}
              onChange={(value) => setStressSeedStart(typeof value === 'number' ? value : 1)}
              style={{ width: 100 }}
            />
          </label>
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            loading={stressing}
            onClick={() => void runStress()}
          >
            开始对拍
          </Button>
        </div>
        {missingStressAssets.length > 0 ? (
          <Alert
            className="tool-alert"
            type="warning"
            showIcon
            message="缺少对拍所需资产"
            description={`请先在“程序资产”上传并编译 ${missingStressAssets.join('、')}。点击对拍仍可查看后端错误。`}
          />
        ) : null}
        {stressError ? (
          <Alert
            className="tool-alert"
            type="error"
            showIcon
            message="对拍失败"
            description={stressError}
          />
        ) : null}
        {stressResult ? (
          <div className="tool-result">
            <div
              className={`tool-stats${
                stressResult.mismatch ? ' tool-stats-warn' : ' tool-stats-ok'
              }`}
            >
              <span className="tool-stats-main">
                {stressResult.mismatch ? '发现反例' : '未发现反例'}
              </span>
              <span className="muted">
                通过 {stressResult.passed} / {stressResult.total}
              </span>
            </div>
            {stressResult.mismatch ? (
              <>
                <Alert
                  className="tool-alert"
                  type="warning"
                  showIcon
                  message={`首个反例 seed ${stressResult.mismatch.seed}`}
                  description={
                    <span>
                      已保存到{' '}
                      <span className="mono">{stressResult.mismatch.path}</span>
                    </span>
                  }
                />
                <div className="tool-output-grid">
                  <OutputBlock title="输入" content={stressResult.mismatch.input} />
                  <OutputBlock title="std 输出" content={stressResult.mismatch.stdOutput} />
                  <OutputBlock
                    title="brute 输出"
                    content={stressResult.mismatch.bruteOutput}
                  />
                </div>
              </>
            ) : (
              <Alert
                className="tool-alert"
                type="success"
                showIcon
                message="未发现反例"
                description={`已对拍 ${stressResult.total} 轮，std 与 brute 输出全部一致。`}
              />
            )}
          </div>
        ) : null}
      </Card>
    </div>
  );

  const dataPlanPanel = problem ? (
    <DataPlanPanel problemId={problemId} problem={problem} />
  ) : null;

  const validateColumns: TableColumnsType<ValidateTestcaseResult> = [
    {
      title: '测试点 ID',
      dataIndex: 'testcaseId',
      width: 120,
      render: (value: number) => <span className="mono">#{value}</span>,
    },
    {
      title: '结果',
      dataIndex: 'ok',
      width: 96,
      render: (ok: boolean) =>
        ok ? <Tag color="green">通过</Tag> : <Tag color="red">失败</Tag>,
    },
    {
      title: '消息',
      dataIndex: 'message',
      render: (value: string) =>
        value ? (
          <span className="validator-message" title={value}>
            {value}
          </span>
        ) : (
          <span className="muted">—</span>
        ),
    },
  ];

  const validatorAsset = assetsById.get('validator');
  const hasValidator = Boolean(validatorAsset);
  const stdAsset = assetsById.get('std');
  const hasStdSource = Boolean(stdAsset?.language);
  const selfTestColumns: TableColumnsType<SelfTestTestcaseResult> = [
    {
      title: '测试点 ID',
      dataIndex: 'testcaseId',
      width: 100,
      render: (value: number) => <span className="mono">#{value}</span>,
    },
    {
      title: '结果',
      dataIndex: 'verdict',
      width: 82,
      render: (verdict: SelfTestTestcaseResult['verdict']) => (
        <VerdictBadge verdict={verdict} />
      ),
    },
    {
      title: '用时',
      dataIndex: 'timeMs',
      width: 88,
      align: 'right',
      render: (value: number) => formatRunTime(value),
    },
    {
      title: '内存',
      dataIndex: 'memoryKb',
      width: 92,
      align: 'right',
      render: (value: number) => formatMemoryKb(value),
    },
    {
      title: '得分',
      dataIndex: 'score',
      width: 64,
      align: 'right',
      render: (value: number) => <span className="score-value">{value}</span>,
    },
    {
      title: '消息',
      dataIndex: 'message',
      render: (value: string) =>
        value ? (
          <span className="validator-message" title={value}>
            {value}
          </span>
        ) : (
          <span className="muted">—</span>
        ),
    },
  ];
  const selfTestPassed = (selfTestResult?.results ?? []).filter(
    (item) => item.verdict === 'AC',
  ).length;
  const selfTestTotal = selfTestResult?.results.length ?? 0;
  const validationPanel = (
    <div className="selftest-grid">
      <Card className="oij-card" title="Validator 校验">
        <div className="validator-hint muted">
          validator 通过 stdin 读取每个测试输入；退出码 0 视为通过，非 0 或超时视为失败。
        </div>
        <div className="validator-toolbar">
          <Space wrap>
            <Button
              type="primary"
              icon={<PlayCircleOutlined />}
              loading={validating}
              onClick={() => void runValidation()}
            >
              运行 validator
            </Button>
            <Button
              icon={<ReloadOutlined />}
              loading={testcasesQuery.isFetching}
              onClick={() => void testcasesQuery.refetch()}
            >
              刷新测试点
            </Button>
          </Space>
          <span className="muted">
            测试点 {testcases.length} 个 · validator{' '}
            {hasValidator ? `已上传（${validatorAsset?.name ?? ''}）` : '未上传'}
          </span>
        </div>

        {!hasValidator ? (
          <Alert
            className="validator-alert"
            type="warning"
            showIcon
            message="尚未上传 validator"
            description="请先在“程序资产”上传 validator.cpp 并编译，才能运行校验。"
          />
        ) : null}
        {testcases.length === 0 ? (
          <Alert
            className="validator-alert"
            type="warning"
            showIcon
            message="没有测试数据"
            description="请先在“测试数据”Tab 导入 zip 后再运行 validator。"
          />
        ) : null}
        {validationError ? (
          <Alert
            className="validator-alert"
            type="error"
            showIcon
            message="validator 运行失败"
            description={validationError}
          />
        ) : null}

        {validationResult ? (
          <div className="validator-result">
            <div
              className={`validator-summary${
                validationResult.total > 0 && validationResult.passed === validationResult.total
                  ? ' validator-summary-ok'
                  : ' validator-summary-warn'
              }`}
            >
              <span className="validator-summary-main">
                {validationResult.total === 0
                  ? '未执行'
                  : `${validationResult.passed} / ${validationResult.total} 通过`}
              </span>
              <span className="muted">
                通过 {validationResult.passed} · 失败{' '}
                {validationResult.total - validationResult.passed}
              </span>
            </div>
            {validationResult.total === 0 ? (
              <Alert
                className="validator-alert"
                type="warning"
                showIcon
                message="没有测试数据，validator 未执行"
                description="请先在“测试数据”Tab 上传 zip。"
              />
            ) : (
              <Table<ValidateTestcaseResult>
                className="oij-table"
                rowKey="testcaseId"
                size="small"
                columns={validateColumns}
                dataSource={validationResult.results}
                pagination={false}
              />
            )}
          </div>
        ) : null}
      </Card>

      <Card
        className="oij-card"
        title="STD 自测"
        extra={<span className="muted">SPJ 仍由 pipeline 的 checker 处理</span>}
      >
        <div className="validator-hint muted">
          std 在沙箱中逐测试点运行，比较输出与标准答案；显示总分与每个测试点的结果。
        </div>
        <div className="validator-toolbar">
          <Space wrap>
            <Button
              type="primary"
              icon={<PlayCircleOutlined />}
              loading={selfTesting}
              onClick={() => void runSelfTest()}
            >
              运行 std 自测
            </Button>
            <Button
              icon={<ReloadOutlined />}
              loading={testcasesQuery.isFetching}
              onClick={() => void testcasesQuery.refetch()}
            >
              刷新测试点
            </Button>
          </Space>
          <span className="muted">
            测试点 {testcases.length} 个 · std{' '}
            {hasStdSource ? `已上传（${stdAsset?.name ?? ''}）` : '未上传'}
          </span>
        </div>

        {!hasStdSource ? (
          <Alert
            className="validator-alert"
            type="warning"
            showIcon
            message="尚未上传 std"
            description="请先在“程序资产”上传 std.cpp 并编译，才能运行自测。"
          />
        ) : null}
        {testcases.length === 0 ? (
          <Alert
            className="validator-alert"
            type="warning"
            showIcon
            message="没有测试数据"
            description="请先在“测试数据”Tab 导入 zip 后再运行 std 自测。"
          />
        ) : null}
        {selfTestError ? (
          <Alert
            className="validator-alert"
            type="error"
            showIcon
            message="std 自测运行失败"
            description={selfTestError}
          />
        ) : null}

        {selfTestResult ? (
          <div className="validator-result">
            <div
              className={`validator-summary${
                selfTestTotal > 0 && selfTestPassed === selfTestTotal
                  ? ' validator-summary-ok'
                  : ' validator-summary-warn'
              }`}
            >
              <span className="validator-summary-main">
                {selfTestTotal === 0 ? '未执行' : `${selfTestResult.score} 分`}
              </span>
              <span className="muted">
                AC {selfTestPassed} / {selfTestTotal}
              </span>
            </div>
            {selfTestTotal === 0 ? (
              <Alert
                className="validator-alert"
                type="warning"
                showIcon
                message="没有测试数据，std 自测未执行"
                description="请先在“测试数据”Tab 上传 zip。"
              />
            ) : (
              <Table<SelfTestTestcaseResult>
                className="oij-table"
                rowKey="testcaseId"
                size="small"
                columns={selfTestColumns}
                dataSource={selfTestResult.results}
                pagination={false}
                scroll={{ x: 620 }}
              />
            )}
          </div>
        ) : null}
      </Card>
    </div>
  );

  return (
    <div>
      <PageHead
        breadcrumb={[
          { label: '管理', to: '/admin/problems' },
          { label: '题目', to: '/admin/problems' },
          { label: `#${problem.id}` },
        ]}
        title={problem.title}
        tags={
          <>
            <Tag className="mono">#{problem.id}</Tag>
            <Tag color={problem.visibility === 'hidden' ? 'gold' : 'green'}>
              {problem.visibility === 'hidden' ? '隐藏' : '公开'}
            </Tag>
            <Tag color="blue">{problemTypeLabel(problem.type)}</Tag>
            <Tag>{difficultyLabel(problem.difficulty)}</Tag>
          </>
        }
        subtitle={`时间限制 ${formatTimeLimit(problem.timeMs)} · 内存限制 ${formatMemoryLimit(
          problem.memoryMb,
        )}`}
        extra={
          <Space wrap>
            <Button
              loading={exporting === 'oi'}
              disabled={exporting !== null}
              onClick={() => void downloadProblemExport('oi')}
            >
              导出 OI 题包
            </Button>
            <Button
              loading={exporting === 'cena'}
              disabled={exporting !== null}
              onClick={() => void downloadProblemExport('cena')}
            >
              导出 Cena 题包
            </Button>
            <Button
              loading={exporting === 'lemon'}
              disabled={exporting !== null}
              onClick={() => void downloadProblemExport('lemon')}
            >
              导出 Lemon 题包
            </Button>
            {problem.visibility === 'public' ? (
              <Link to={`/problem/${problem.id}`}>
                <Button>前台查看</Button>
              </Link>
            ) : (
              <Button disabled>前台不可见</Button>
            )}
            <Link to="/admin/problems">
              <Button>返回列表</Button>
            </Link>
          </Space>
        }
      />

      <Tabs
        className="problem-tabs admin-tabs"
        activeKey={activeTab}
        onChange={setActiveTab}
        items={
          isObjective
            ? [
                { key: 'basic', label: '基本信息', children: basicPanel },
                {
                  key: 'objective',
                  label: `客观题 (${objectiveDraft.length})`,
                  children: objectivePanel,
                },
              ]
            : [
                { key: 'basic', label: '基本信息', children: basicPanel },
                { key: 'assets', label: '程序资产', children: assetsPanel },
                { key: 'plan', label: '数据计划', children: dataPlanPanel },
                { key: 'data', label: '测试数据', children: dataPanel },
                { key: 'tools', label: '生成与对拍', children: toolsPanel },
                { key: 'validation', label: '校验与自测', children: validationPanel },
              ]
        }
      />

      <Modal
        title={`查看源码 · ${ASSET_META[sourceKind].label}${sourceName ? ` · ${sourceName}` : ''}`}
        open={sourceOpen}
        onCancel={() => setSourceOpen(false)}
        footer={null}
        width={900}
        destroyOnHidden
      >
        {sourceLoading ? (
          <div className="inline-loading">
            <Spin />
          </div>
        ) : sourceError ? (
          <Alert type="error" showIcon message={sourceError} />
        ) : (
          <CodeBlock code={sourceText} maxHeight={560} />
        )}
      </Modal>
    </div>
  );
}
