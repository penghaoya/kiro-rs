use clap::Parser;

/// Anthropic <-> Kiro API 客户端
#[derive(Parser, Debug)]
#[command(version, about, long_about = None)]
pub struct Args {
    /// 数据目录（配置、凭证及所有运行时数据默认存放于此）
    #[arg(short = 'd', long, env = "KIRO_DATA_DIR", default_value = "data")]
    pub data_dir: String,

    /// 配置文件路径（默认 <data-dir>/config.json）
    #[arg(short, long)]
    pub config: Option<String>,

    /// 凭证文件路径（默认 <data-dir>/credentials.json）
    #[arg(long)]
    pub credentials: Option<String>,
}
