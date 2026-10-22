"""MongoDB 文档模型基类：集合本身没有结构约束，字段定义与校验放在应用层。

约定：
  写：`FileDocument(...)` 构造即校验，类型不对直接抛 ValidationError；
      入库用 `doc.to_mongo()`（自动去掉尚未生成的 `_id`，未赋值的可选字段不落 null）。
  读：`FileDocument.from_mongo(raw)`，读路径不能因为历史脏数据把接口打挂，
      校验失败只记告警，再按原始值构造（缺字段走默认值，类型不强制转换）。
"""
import logging
from typing import Any, Self

from bson import ObjectId
from pydantic import BaseModel, ConfigDict, Field, ValidationError

logger = logging.getLogger(__name__)


class MongoDocument(BaseModel):
    model_config = ConfigDict(
        extra="ignore",  # 历史遗留字段直接忽略，避免读取时报错
        populate_by_name=True,  # `_id=` 与 `id=` 两种写法都能构造
        arbitrary_types_allowed=True,  # ObjectId 等 bson 类型
    )

    # MongoDB 的 _id；写入前为 None（由 insert_one 生成）
    id: ObjectId | None = Field(default=None, alias="_id")

    def to_mongo(self) -> dict[str, Any]:
        """转为 insert_one / $push 用的文档字典。"""
        return self.model_dump(exclude={"id"}, exclude_none=True)

    @classmethod
    def from_mongo(cls, raw: dict[str, Any] | None) -> Self:
        """读路径入口：优先严格校验，失败降级为原值 + 默认值。"""
        raw = raw or {}
        try:
            return cls.model_validate(raw)
        except ValidationError as exc:
            logger.warning(
                "%s 文档结构校验失败，按原始数据继续: %s",
                cls.__name__,
                exc.errors(include_url=False),
            )
            return cls.model_construct(**cls._raw_field_values(raw))

    @classmethod
    def _raw_field_values(cls, raw: dict[str, Any]) -> dict[str, Any]:
        """从原始文档里按字段别名/字段名取值，供 model_construct 绕过校验。

        必填字段缺失时补 None（而不是让属性缺失），保证调用方 attr 访问不会抛
        AttributeError；有默认值的字段交给 model_construct 填默认值。
        """
        values: dict[str, Any] = {}
        for name, field in cls.model_fields.items():
            key = field.alias or name
            if key in raw:
                values[name] = raw[key]
            elif name in raw:
                values[name] = raw[name]
            elif field.is_required():
                values[name] = None
        return values
