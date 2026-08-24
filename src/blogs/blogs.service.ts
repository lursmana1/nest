import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Blog } from './entities/blog.entity';
import { S3Service } from '../s3/s3.service';

export type BlogWithCreatorName = Omit<Blog, 'creator'> & {
  creator: { name: string } | null;
};

const PAGE_SIZE = 9;

export type PaginatedBlogs = {
  data: BlogWithCreatorName[];
  total: number;
  page: number;
  totalPages: number;
};

@Injectable()
export class BlogsService {
  constructor(
    @InjectRepository(Blog)
    private readonly blogsRepository: Repository<Blog>,
    private readonly s3Service: S3Service,
  ) {}

  async create(data: {
    creatorId: number;
    name: string;
    description: string;
    content: string;
    file: Express.Multer.File;
  }): Promise<BlogWithCreatorName> {
    const { url } = await this.s3Service.uploadPublicFile({
      file: data.file,
      folder: 'blogs',
    });

    const blog = this.blogsRepository.create({
      creator: { id: data.creatorId },
      name: data.name,
      description: data.description,
      content: data.content,
      imageUrl: url,
    });

    const saved = await this.blogsRepository.save(blog);
    return this.findOne(saved.id);
  }

  async findAll(page = 1): Promise<PaginatedBlogs> {
    const pageNum = Math.max(1, page);
    const [blogs, total] = await this.blogsRepository.findAndCount({
      relations: ['creator'],
      order: { createdAt: 'DESC' },
      skip: (pageNum - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    });
    const totalPages = Math.ceil(total / PAGE_SIZE);
    return {
      data: blogs.map((b) => this.mapCreator(b)),
      total,
      page: pageNum,
      totalPages,
    };
  }

  async findOne(id: number): Promise<BlogWithCreatorName> {
    const blog = await this.findOneWithCreator(id);
    return this.mapCreator(blog);
  }

  private async findOneWithCreator(id: number): Promise<Blog> {
    const blog = await this.blogsRepository.findOne({
      where: { id },
      relations: ['creator'],
    });
    if (!blog) {
      throw new NotFoundException(`Blog with ID ${id} not found`);
    }
    return blog;
  }

  private mapCreator(blog: Blog): BlogWithCreatorName {
    return {
      id: blog.id,
      name: blog.name,
      description: blog.description,
      content: blog.content,
      imageUrl: blog.imageUrl,
      createdAt: blog.createdAt,
      creator: blog.creator ? { name: blog.creator.name } : null,
    };
  }

  async update(
    id: number,
    data: {
      name?: string;
      description?: string;
      content?: string;
      file?: Express.Multer.File;
    },
  ): Promise<BlogWithCreatorName> {
    const blog = await this.findOneWithCreator(id);

    if (data.name !== undefined) blog.name = data.name;
    if (data.description !== undefined) blog.description = data.description;
    if (data.content !== undefined) blog.content = data.content;
    if (data.file) {
      const { url } = await this.s3Service.uploadPublicFile({
        file: data.file,
        folder: 'blogs',
      });
      blog.imageUrl = url;
    }

    await this.blogsRepository.save(blog);
    return this.mapCreator(blog);
  }

  async remove(id: number): Promise<void> {
    const blog = await this.blogsRepository.findOne({ where: { id } });
    if (!blog) {
      throw new NotFoundException(`Blog with ID ${id} not found`);
    }
    await this.blogsRepository.remove(blog);
  }
}
