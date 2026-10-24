# 表格抽取方法对照（PyMuPDF vs pdfplumber）

| 方法 | 检出表格 | 有效表格 | 有效率 | 图注关联率 | 平均行×列 | 数值占比 | 空单元格 | 列一致性 |
|---|---|---|---|---|---|---|---|---|
| pymupdf | 72 | 39 | 54.2% | 34.7% | 4.9×10.5 | 16.7% | 37.6% | 100.0% |
| pdfplumber | 80 | 28 | 35.0% | 25.0% | 3.6×14.2 | 10.5% | 44.2% | 100.0% |

## 样例

### pymupdf · Attention Is All You Need · p9

|  | train
N d d h d d P ϵ
model ff k v drop ls steps | PPL BLEU params
(dev) (dev) ×106 |
|---|---|---|
| base | 6 512 2048 8 64 64 0.1 0.1 100K | 4.92 25.8 65 |
| (A) | 1 512 512
4 128 128
16 32 32
32 16 16 | 5.29 24.9
5.00 25.5
4.91 25.8
5.01 25.4 |
| (B) | 16
32 | 5.16 25.1 58
5.01 25.4 60 |
| (C) | 2
4
8
256 32 32
1024 128 128
1024
4096 | 6.11 23.7 36
5.19 25.3 50
4.88 25.5 80
5.75 24.5 28
4.66 26.0 168
5.12 25.4 53
4.75 26.2 90 |
| (D) | 0.0
0.2
0.0
0.2 | 5.77 24.6
4.95 25.5
4.67 25.3
5.47 25.7 |

### pymupdf · Attention Is All You Need · p10

| Parser | Training | WSJ 23 F1 |
|---|---|---|
| Vinyals & Kaiser el al. (2014) [37]
Petrov et al. (2006) [29]
Zhu et al. (2013) [40]
Dyer et al. (2016) [8] | WSJ only, discriminative
WSJ only, discriminative
WSJ only, discriminative
WSJ only, discriminative | 88.3
90.4
90.4
91.7 |
| Transformer (4 layers) | WSJ only, discriminative | 91.3 |
| Zhu et al. (2013) [40]
Huang & Harper (2009) [14]
McClosky et al. (2006) [26]
Vinyals & Kaiser el al. (2014) [37] | semi-supervised
semi-supervised
semi-supervised
semi-supervised | 91.3
91.3
92.1
92.1 |
| Transformer (4 layers) | semi-supervised | 92.7 |
| Luong et al. (2015) [23]
Dyer et al. (2016) [8] | multi-task
generative | 93.0
93.3 |

### pdfplumber · Attention Is All You Need · p13

|  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | st |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
|  |  |  |  |  |  |  |  |  |  |  |  |  |  | n |  | ne |  |  |  |  |  |  |  |  | no |  |  |  |  |  |  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |  |  |  | yt |  |  | ac |  | m |  | d |  |  |  |  | g |  | ita |  |  | s |  | t |  | > |  |  |  |  |  |  |
|  |  |  |  |  |  | t |  |  |  |  | iro |  |  | ir |  | nre | e | es |  |  | e | 9 | ni |  | rts |  | gn | se | e | lu |  | S | >d | >d | >d | >d | >d | >d |
|  |  |  |  |  | si | iri |  | ta |  |  | ja |  |  | em |  | vo | va | sa | we | sw | cn | 00 | ka | e | ig |  | it | co | ro | ciff |  | OE | ap | ap | ap | ap | ap | ap |
| tI |  | si |  | ni | ht | ps |  | ht |  | a | m | fo |  | A |  | g | h | p | n | al | is | 2 | m | ht | er | ro | ov | rp | m | id | . | < | < | < | < | < | < | < |

### pdfplumber · Attention Is All You Need · p13

| tI | si | ni | si | tir | ta | a | yt | fo | n | st | e | d | w | s | e | 9 | g | e | n | ro | g | ss | er | tlu | . | > | > | > | > | > | > | > |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
|  |  |  | ht | ip | ht |  | iro |  | aci | ne | va | es | en | wa | cni | 00 | nik | ht | oit |  | nit | e | o | ci |  | SO | da | da | da | da | da | da |
|  |  |  |  | s |  |  | ja |  | re | m | h | sa |  | l | s | 2 | a |  | art |  | ov | cor | m | ffi |  | E | p< | p< | p< | p< | p< | p< |
|  |  |  |  |  |  |  | m |  | m | nr |  | p |  |  |  |  | m |  | sig |  |  | p |  | d |  | < |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |  | A | ev |  |  |  |  |  |  |  |  | er |  |  |  |  |  |  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |  |  | og |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |

## 推荐

- PyMuPDF 只作为表格候选检测器：有效率 54.2%，比 pdfplumber 好，但样例行仍有错位；
- 检出后必须做结构校验（列一致性、数值占比、空单元格率），不通过不要转 markdown 入库；
- 校验失败或合并单元格/跨页表：保存表格区域截图，查询时交给 VLM 读，不要硬造结构；
- pdfplumber 可用于有完整边框的表格做二次验证，不建议作为主链路。

## 口径

- 无人工单元格金标，以上是结构代理指标，不等于单元格准确率；
- 有效表格 = >=2 行、>=2 列、>=4 个非空单元格；
- 图注关联 = 表格 bbox 与同页 `Table N` 图注距离 <= 120pt；
- 合并单元格、无边框表、跨页表仍可能被误判，需要人工抽查样例。