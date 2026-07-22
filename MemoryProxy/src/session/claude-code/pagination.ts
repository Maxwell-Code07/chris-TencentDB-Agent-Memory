/**
 * Claude Code AskUserQuestion 分页布局器。
 *
 * 背景：CC AskUserQuestion 单 question 最多 4 个 option。以往我们按"3 个真实
 * 选项 + 1 个'更多→'"硬分页，导致 `total mod 3 == 1`（4、7、10、13…）时末页
 * 只剩 1 个真实选项。此时 form builder 会因 <2 选项 assert 失败，而 init.ts
 * 又在 MORE 处理里悄悄 auto-select 那个孤零零的选项 —— 用户从"点更多"直接
 * 跳到"被替我选中"，体验很怪。
 *
 * 新策略：**末页永远不能只有 1 个真实选项**。
 *   - total ≤ 4：单页展示所有（可用满 4 个 slot，不放 MORE）
 *   - total > 4 且 total mod 3 == 1：把倒数第二页减 1 匀到末页，让两页各 2 个
 *   - 其它：常规 3 每页 + MORE，末页 2 或 3 个
 *
 * 效果：
 *   total=4  → 页 [4]                     （单页，无 MORE）
 *   total=5  → 页 [3+MORE, 2]             （无变化）
 *   total=6  → 页 [3+MORE, 3]             （无变化）
 *   total=7  → 页 [3+MORE, 2+MORE, 2]     （原为 3+MORE, 3+MORE, 1）
 *   total=8  → 页 [3+MORE, 3+MORE, 2]
 *   total=9  → 页 [3+MORE, 3+MORE, 3]
 *   total=10 → 页 [3+MORE, 3+MORE, 2+MORE, 2] （原为 3+MORE ×3, 1）
 *   total=13 → 页 [3+MORE ×3, 2+MORE, 2]
 *
 * agents 和 tasks 共用同一分页，行为一致。
 */

/** CC AskUserQuestion 单 question 硬上限（含 MORE 槽位）。 */
export const CC_MAX_OPTIONS = 4;

/** 非末页真实选项数（保留 1 slot 给 MORE→）。 */
export const CC_PAGE_SIZE = 3;

/** 单页展示阈值：total ≤ 此值时不分页、不放 MORE，一页展示全部。 */
export const CC_SINGLE_PAGE_LIMIT = CC_MAX_OPTIONS;

export interface PageSlice {
  /** 该 page 覆盖的元素区间 [start, end)，start 含 end 不含 —— 直接 slice 用。 */
  start: number;
  end: number;
  /** 该 page 是否是最后一页（末页不追加 MORE 选项）。 */
  isLastPage: boolean;
  /** 该 page 展示的真实选项数（= end - start）。 */
  count: number;
  /** 分页后的总页数（total ≤ 4 时为 1）。 */
  totalPages: number;
  /** 全体元素数量，方便调用方拼提示文案。 */
  total: number;
}

/**
 * 计算给定 `total` 项、目标 `pageIndex`（0-based）的切片区间。
 *
 * 保证：任何合法的 pageIndex 返回的 `count >= 2`（除非 total < 2，此时是
 * form builder 上游的边界问题，非本函数职责）。
 *
 * pageIndex 超出 totalPages-1 时，钳制到最后一页（防御性；正常调用方会先
 * 用 totalPages-1 计算 safeNextPage，见 init.ts MORE 分支）。
 */
export function computePagination(total: number, pageIndex: number): PageSlice {
  const safeTotal = Math.max(0, total);

  // 单页阈值：≤ CC_SINGLE_PAGE_LIMIT 时不分页。
  if (safeTotal <= CC_SINGLE_PAGE_LIMIT) {
    return {
      start: 0,
      end: safeTotal,
      isLastPage: true,
      count: safeTotal,
      totalPages: 1,
      total: safeTotal,
    };
  }

  // 常规多页布局。当 total mod 3 == 1 时（5+ 且 ≡ 1 mod 3 = 7, 10, 13…），
  // 把倒数第二页缩到 2 项，末页 2 项，避免 solo 末页。
  const balanceLastTwo = safeTotal % CC_PAGE_SIZE === 1;

  let totalPages: number;
  if (balanceLastTwo) {
    // 前 (total - 4) 项按 3 每页 + 剩下 4 项拆 2+2，共 (total-4)/3 + 2 页。
    // total=7 → 前 3 项 1 页 + 2+2 = 3 页
    // total=10 → 前 6 项 2 页 + 2+2 = 4 页
    // total=13 → 前 9 项 3 页 + 2+2 = 5 页
    totalPages = (safeTotal - 4) / CC_PAGE_SIZE + 2;
  } else {
    totalPages = Math.ceil(safeTotal / CC_PAGE_SIZE);
  }

  // 钳制 pageIndex 到合法范围（防御性）。
  const idx = Math.max(0, Math.min(pageIndex, totalPages - 1));

  const isLastPage = idx === totalPages - 1;
  const isSecondLast = balanceLastTwo && idx === totalPages - 2;

  let start: number;
  let end: number;
  if (balanceLastTwo && (isLastPage || isSecondLast)) {
    // 倒数两页各 2 个：倒数第二页起点 = total - 4，末页起点 = total - 2
    if (isSecondLast) {
      start = safeTotal - 4;
      end = safeTotal - 2;
    } else {
      start = safeTotal - 2;
      end = safeTotal;
    }
  } else {
    start = idx * CC_PAGE_SIZE;
    end = Math.min(start + CC_PAGE_SIZE, safeTotal);
  }

  return {
    start,
    end,
    isLastPage,
    count: end - start,
    totalPages,
    total: safeTotal,
  };
}
