// compact bundle에 full-history runtime을 가져오지 않도록 버전/기본 OFF 정책만 분리한다.
export const SEC_RAW_SCHEMA_VERSION = 1;
export const SEC_RAW_DATA_VERSION = 2;
export const standardRawEnabled = environment => environment.SEC_STANDARD_RAW_FIELDS_ENABLED === 'true';
