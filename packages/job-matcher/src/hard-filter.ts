/**
 * 硬条件过滤 —— 全部确定性规则（A3：程序负责硬性过滤）。
 * 命中任一规则即拒绝并给出 reason（decision='filtered'）。
 */

export interface JobFacts {
  title: string;
  city: string;
  jobType?: string;
  workMode?: string;
  tags: string[];
  description: string;
}

export interface HardFilterConfig {
  targetCities: string[];
  excludeCities: string[];
  excludeJobTypes: string[];
  excludeWorkModes: string[];
  targetJobTitles: string[];
}

export type HardFilterResult = { passed: true } | { passed: false; reason: string };

const containsAny = (text: string, terms: string[]): boolean => terms.some((t) => text.includes(t));

export function hardFilter(cfg: HardFilterConfig, job: JobFacts): HardFilterResult {
  if (cfg.excludeCities.includes(job.city)) return { passed: false, reason: 'exclude_city' };
  if (!cfg.targetCities.includes(job.city)) return { passed: false, reason: 'target_city_mismatch' };
  if (containsAny(job.jobType ?? '', cfg.excludeJobTypes)) return { passed: false, reason: 'exclude_job_type' };
  const blob = `${job.title} ${job.description} ${job.tags.join(' ')}`;
  if (containsAny(blob, cfg.excludeJobTypes)) return { passed: false, reason: 'exclude_job_type' };
  if (job.workMode && containsAny(job.workMode, cfg.excludeWorkModes)) {
    return { passed: false, reason: 'exclude_work_mode' };
  }
  if (containsAny(blob, cfg.excludeWorkModes)) return { passed: false, reason: 'exclude_work_mode' };
  if (!containsAny(job.title, cfg.targetJobTitles)) {
    // 岗位名未命中目标关键词：仍允许进入评分（方向维会给低分），不做硬拒
    return { passed: true };
  }
  return { passed: true };
}
